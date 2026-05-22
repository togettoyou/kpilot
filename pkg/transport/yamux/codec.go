package transport

import (
	"bufio"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"google.golang.org/protobuf/proto"
)

// maxMessageSize caps a single proto message wire size. Protects
// against a peer (buggy or malicious) sending a giant length prefix
// that would allocate a multi-GiB buffer. 64 MiB matches the v1
// gRPC MaxRecvMsgSize / MaxSendMsgSize; bigger payloads (chart
// blobs, log dumps) flow as raw bytes after the framed header, not
// as one giant proto message.
const maxMessageSize = 64 * 1024 * 1024

// Codec frames length-prefixed proto messages on top of an
// io.ReadWriter (typically one yamux stream). It can optionally
// switch to gzip mode mid-stream — useful for the JSON / text
// payloads (resource list, HTTP responses, pod logs) where
// gzip cuts wire size 5-8× on cross-WAN links.
//
// Wire format on one stream:
//
//	[uvarint len][protobuf bytes]   ← StreamHeader (always plaintext)
//	[uvarint len][protobuf bytes]   ← typed first message, e.g. HTTPRequestStart
//	...                              ← additional framed messages, OR raw bytes
//	(stream half-close or close)
//
// After the StreamHeader is exchanged, callers may EnableGzip() if
// the header negotiated it. The header itself is never compressed
// (avoids a chicken-and-egg with the gzip-or-not decision).
//
// For long byte streams (HTTP body, chart blob, SSE response), the
// usual pattern is one framed *Start message followed by raw bytes
// through Writer() / Reader() until half-close. The framing layer
// stays out of the way — bytes pass through unmodified (or through
// gzip if enabled).
//
// Concurrency: ONE reader goroutine + ONE writer goroutine per
// Codec. writeMu serializes WriteMsg vs raw-Writer torn writes if
// they slip in concurrently, but mixing them on purpose corrupts
// the framing. Reads have no internal lock — two goroutines
// calling ReadMsg / Reader concurrently will interleave bufio
// reads and produce truncated frames. yamux gives each stream
// its own send/recv goroutine ownership, so in real use each
// stream's Codec sees one reader + one writer total.
type Codec struct {
	rw io.ReadWriter

	// reader / writer are the active sinks for framed messages
	// AND raw bytes. They start as rw and get swapped to gzip
	// readers/writers when EnableGzip is called.
	reader io.Reader
	writer io.Writer

	// br buffers reads so binary.ReadUvarint doesn't issue
	// 1-byte syscalls against the underlying conn. The buffer
	// is allocated lazily: a stream that only writes never reads
	// uvarint lengths.
	br *bufio.Reader

	// gzip plumbing — kept so we can Close the writer (flushes
	// final gzip block) on shutdown.
	//
	// Reader-side init is LAZY: gzip.NewReader blocks reading the
	// gzip magic header bytes, which can't arrive until the peer's
	// first Write through gzip.Writer. If we eagerly initialize
	// the reader from EnableGzip, two ends calling EnableGzip
	// concurrently deadlock (each waits for the other's first
	// write before the gzip header lands). Instead, EnableGzip
	// flips gzipPending=true; the actual gzip.NewReader runs the
	// first time something reads (lazyInitReader). Writer side is
	// eager — gzip.NewWriter doesn't block and we Flush after
	// init so the peer's eventual lazy NewReader sees the magic.
	gzipEnabled bool
	gzipPending bool
	gzw         *gzip.Writer
	gzr         *gzip.Reader

	// writeMu serialises WriteMsg + raw Writer access. Multiple
	// callers MUST NOT concurrently mix framed writes and raw
	// writes on the same Codec — that's a stream protocol error
	// not a concurrency error — but the lock protects against
	// torn writes if one of them slips through.
	writeMu sync.Mutex
}

// NewCodec wraps an io.ReadWriter (yamux stream, or net.Pipe for
// tests) with the framing/gzip codec. Reads go through bufio so
// uvarint length prefixes don't generate 1-byte syscalls.
func NewCodec(rw io.ReadWriter) *Codec {
	return &Codec{
		rw:     rw,
		reader: rw,
		writer: rw,
		br:     bufio.NewReader(rw),
	}
}

// EnableGzip wraps the writer in gzip immediately and arms the
// reader for lazy gzip init on first read. Must be called on
// BOTH ends after the StreamHeader is exchanged, and only when
// StreamHeader.gzip is true.
//
// Writer-side semantics: gzip.NewWriter doesn't block; we Flush
// right away so the gzip magic header lands on the wire — the
// peer's reader needs those bytes to initialize its own
// gzip.Reader without blocking.
//
// Reader-side semantics: gzip.NewReader BLOCKS reading the magic
// header from its source. If we eagerly call NewReader from
// EnableGzip, two ends calling EnableGzip concurrently deadlock
// (each waits for the other's first write to land before it can
// init). Instead, we flip gzipPending=true; lazyInitReader runs
// gzip.NewReader on the first ReadMsg / Reader() call, by which
// time the peer's Flush has placed the magic header on the wire.
//
// Idempotent: calling twice is a no-op.
func (c *Codec) EnableGzip() error {
	if c.gzipEnabled || c.gzipPending {
		return nil
	}
	gzw := gzip.NewWriter(c.rw)
	// Force the gzip header onto the wire NOW so the peer's
	// reader can initialize without blocking on us.
	if err := gzw.Flush(); err != nil {
		return fmt.Errorf("flush gzip header: %w", err)
	}
	c.gzw = gzw
	c.writer = gzw
	c.gzipPending = true
	return nil
}

// lazyInitReader runs gzip.NewReader the first time someone reads.
// By this point the peer has called EnableGzip and Flushed the
// gzip header, so NewReader unblocks immediately. After init the
// reader chain becomes bufio(gzip(bufio(rw))).
//
// On gzip.NewReader failure (corrupt magic / truncated stream)
// we clear gzipPending so retrying doesn't re-call NewReader on
// the same wire position — the failure is permanent for this
// codec; the next read will return raw (broken) bytes which
// triggers a clear "incoming message too large" error rather
// than a confusing retry loop.
func (c *Codec) lazyInitReader() error {
	if c.gzipEnabled || !c.gzipPending {
		return nil
	}
	gzr, err := gzip.NewReader(c.br)
	if err != nil {
		c.gzipPending = false
		return fmt.Errorf("init gzip reader: %w", err)
	}
	c.gzr = gzr
	c.reader = gzr
	// Re-buffer over gzip so binary.ReadUvarint doesn't fetch one
	// byte at a time through the gzip layer.
	c.br = bufio.NewReader(gzr)
	c.gzipEnabled = true
	c.gzipPending = false
	return nil
}

// Close flushes any pending gzip block. Must be called before the
// underlying stream is closed if gzip is enabled — otherwise the
// peer's gzip.Reader sees a truncated stream.
//
// Idempotent: nils out the gzip.Writer reference so a repeat Close
// doesn't call into already-closed gzip internals.
//
// Does NOT close the underlying io.ReadWriter. Caller owns that.
func (c *Codec) Close() error {
	if c.gzw == nil {
		return nil
	}
	err := c.gzw.Close()
	c.gzw = nil
	return err
}

// WriteMsg writes one proto message framed with a uvarint length
// prefix. Flushes the gzip writer after the message so the receiver
// can decode immediately (without flush, small control messages
// would buffer inside the gzip block until ~32 KiB accumulated).
func (c *Codec) WriteMsg(m proto.Message) error {
	payload, err := proto.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if len(payload) > maxMessageSize {
		return fmt.Errorf("message too large: %d > %d", len(payload), maxMessageSize)
	}

	var lenBuf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(lenBuf[:], uint64(len(payload)))

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.writer.Write(lenBuf[:n]); err != nil {
		return err
	}
	if _, err := c.writer.Write(payload); err != nil {
		return err
	}
	if c.gzipEnabled {
		if err := c.gzw.Flush(); err != nil {
			return err
		}
	}
	return nil
}

// ReadMsg reads one length-prefixed proto message. Returns io.EOF
// when the peer half-closes its write side; any partial read is an
// error (truncated frame).
func (c *Codec) ReadMsg(m proto.Message) error {
	buf, err := c.ReadRaw()
	if err != nil {
		return err
	}
	return proto.Unmarshal(buf, m)
}

// ReadRaw reads one length-prefixed framed message and returns the
// raw payload bytes (caller picks the proto type to Unmarshal
// against). Useful when one stream carries multiple message types
// distinguished by content rather than by a framing discriminator
// — e.g. STREAM_POD_EXEC's ExecStdin vs ExecResize on the input
// side. proto.Unmarshal silently zeros mismatched fields, so the
// caller can try multiple decodes against the same buffer.
func (c *Codec) ReadRaw() ([]byte, error) {
	if err := c.lazyInitReader(); err != nil {
		return nil, err
	}
	length, err := binary.ReadUvarint(c.br)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("read length prefix: %w", err)
	}
	if length > maxMessageSize {
		return nil, fmt.Errorf("incoming message too large: %d > %d", length, maxMessageSize)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(c.br, buf); err != nil {
		return nil, fmt.Errorf("read payload: %w", err)
	}
	return buf, nil
}

// Reader exposes the (possibly gzipped) byte stream for callers
// that want to transfer raw bytes after the framed control
// messages — HTTP body, SSE chunks, pod log bytes, chart blob.
//
// Once a caller reads raw bytes, the stream's framing is no longer
// recoverable on this codec — caller should either read until
// io.EOF (peer half-closed) or until expected byte count is hit,
// then stop using the codec.
//
// Returns the bufio.Reader so any bytes pre-fetched by earlier
// uvarint reads are drained first.
//
// Triggers lazy gzip-reader init if EnableGzip was called.
// Errors from the lazy init surface on the first Read call
// (Reader returns the codec's reader unchanged; if init fails
// the underlying ReadWriter is what callers see, which fails
// at the gzip-magic mismatch).
func (c *Codec) Reader() io.Reader {
	// Best-effort lazy init; if it errors the caller's first
	// Read will surface the cause (broken pipe / unexpected
	// EOF / gzip magic missing).
	_ = c.lazyInitReader()
	return c.br
}

// Writer exposes the (possibly gzipped) byte sink. Same caveats
// as Reader: once raw bytes flow through it, no more framed
// WriteMsg calls should follow.
func (c *Codec) Writer() io.Writer {
	return c.writer
}
