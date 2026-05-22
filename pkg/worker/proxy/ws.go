package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/rest"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// WSManager runs Pod WebSocket reverse proxy sessions. Phase C
// dropped the in-memory session registry (one yamux stream per
// session, lifetime ends when stream closes).
type WSManager struct {
	dialer *websocket.Dialer
	// k8sCfg + apiTLS power the service-proxy WS fallback.
	k8sCfg *rest.Config
	apiTLS *tls.Config
	router *InClusterRouter
}

func NewWSManager(k8sCfg *rest.Config, router *InClusterRouter) *WSManager {
	m := &WSManager{
		dialer: &websocket.Dialer{
			HandshakeTimeout: 10 * time.Second,
			ReadBufferSize:   4 * 1024,
			WriteBufferSize:  32 * 1024,
		},
		k8sCfg: k8sCfg,
		router: router,
	}
	if k8sCfg != nil {
		if cfg, err := rest.TLSConfigFor(k8sCfg); err == nil {
			m.apiTLS = cfg
		} else {
			log.Printf("[ws-proxy] tls config from rest.Config failed (service-proxy WS fallback disabled): err=%v", err)
		}
	}
	return m
}

// HandleStream is the tunnel entry for STREAM_WS_PROXY. Reads
// WSStartRequest, dials upstream WS, spawns reader (server →
// upstream) + writer (upstream → server) pumps, returns when
// either side terminates. Writes sentinel zero-frame + WSEnd
// before closing the yamux stream.
//
// Server-side input is either WSFrame (forward to upstream) or
// WSEnd (browser-side close). Discriminator: WSFrame with
// non-zero Opcode OR non-empty Data = forward; sentinel zero +
// next-frame WSEnd = close.
func (m *WSManager) HandleStream(ctx context.Context, st *transportv2.Stream) {
	defer st.Close()

	var req pbv2.WSStartRequest
	if err := st.ReadMsg(&req); err != nil {
		log.Printf("[wire] ws read req failed: request=%s err=%v", st.RequestID(), err)
		return
	}

	if req.GetUrl() == "" {
		writeWSEnd(st, 0, "url required")
		return
	}
	if scheme, ok := schemeOf(req.GetUrl()); !ok ||
		(scheme != "ws" && scheme != "wss" && scheme != "http" && scheme != "https") {
		writeWSEnd(st, 0, "unsupported url scheme")
		return
	}

	header := http.Header{}
	for _, h := range req.GetHeaders() {
		header.Add(h.GetName(), h.GetValue())
	}
	for _, drop := range []string{
		"Sec-Websocket-Version", "Sec-Websocket-Key",
		"Sec-Websocket-Extensions", "Connection", "Upgrade",
		"Host",
	} {
		header.Del(drop)
	}

	dialCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, dialResp, err := m.dial(dialCtx, req.GetUrl(), header)
	if err != nil {
		extra := ""
		if dialResp != nil {
			body := readDialBodyExcerpt(dialResp.Body)
			extra = fmt.Sprintf(" status=%d body=%q", dialResp.StatusCode, body)
		}
		log.Printf("[ws-proxy] dial failed: url=%s err=%v%s", req.GetUrl(), err, extra)
		writeWSEnd(st, 0, "dial: "+err.Error())
		return
	}
	defer conn.Close()

	// Reader pump: server → upstream. On exit we MUST close the
	// upstream conn — otherwise the writer pump (main goroutine)
	// keeps reading upstream frames forever even after the
	// browser closed the tab. yamux writes after the server FIN
	// succeed silently (data goes into a black hole), so the
	// writer pump alone can't notice the disconnect.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer conn.Close()
		for {
			var frame pbv2.WSFrame
			if rerr := st.ReadMsg(&frame); rerr != nil {
				return
			}
			if frame.GetOpcode() != 0 || len(frame.GetData()) > 0 {
				op := int(frame.GetOpcode())
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if werr := conn.WriteMessage(op, frame.GetData()); werr != nil {
					log.Printf("[ws-proxy] upstream write failed: %v", werr)
					_ = conn.Close()
					return
				}
				continue
			}
			// Sentinel zero-frame — next message is WSEnd. After
			// closing upstream politely we exit, which makes the
			// writer pump's conn.ReadMessage return → it writes its
			// own WSEnd back, then we both close.
			var end pbv2.WSEnd
			if eerr := st.ReadMsg(&end); eerr != nil {
				_ = conn.Close()
				return
			}
			code := int(end.GetCode())
			if code != 0 {
				_ = conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(code, truncate(end.GetReason(), 100)),
					time.Now().Add(time.Second),
				)
			}
			_ = conn.Close()
			return
		}
	}()

	// Writer pump: upstream → server. Main goroutine runs this so
	// we can write the WSEnd terminator on its exit before returning.
	for {
		opcode, data, rerr := conn.ReadMessage()
		if rerr != nil {
			var ce *websocket.CloseError
			if errors.As(rerr, &ce) {
				writeWSEnd(st, int32(ce.Code), ce.Text)
			} else {
				writeWSEnd(st, 0, rerr.Error())
			}
			break
		}
		if werr := st.WriteMsg(&pbv2.WSFrame{
			Opcode: int32(opcode),
			Data:   data,
		}); werr != nil {
			// Server stream gone — close upstream + exit.
			break
		}
	}
	// Tear down both sides so the reader pump unblocks regardless
	// of which side terminated first. conn.Close handles "yamux
	// closed first" (reader pump already exits naturally on EOF);
	// st.Close handles "upstream closed first" (reader pump is
	// blocked on yamux ReadMsg with no other way to wake up).
	// Both calls are idempotent.
	_ = conn.Close()
	_ = st.Close()
	wg.Wait()
}

// writeWSEnd emits the sentinel zero-WSFrame + the final WSEnd.
func writeWSEnd(st *transportv2.Stream, code int32, reason string) {
	if err := st.WriteMsg(&pbv2.WSFrame{}); err != nil {
		return
	}
	_ = st.WriteMsg(&pbv2.WSEnd{Code: code, Reason: reason})
}

// readDialBodyExcerpt grabs up to 512 bytes of the upstream's
// response body for diagnostics.
func readDialBodyExcerpt(body io.ReadCloser) string {
	if body == nil {
		return ""
	}
	defer body.Close()
	const max = 512
	buf, _ := io.ReadAll(io.LimitReader(body, max+1))
	if len(buf) > max {
		return string(buf[:max]) + "...(truncated)"
	}
	return string(buf)
}

// dial chooses between direct DNS dial and the K8s API server's
// service-proxy subresource based on the per-Worker routing cache.
func (m *WSManager) dial(
	ctx context.Context, rawURL string, header http.Header,
) (*websocket.Conn, *http.Response, error) {
	svc := parseInClusterService(rawURL)
	if svc == nil || m.router == nil || m.k8sCfg == nil {
		return m.dialer.DialContext(ctx, rawURL, header)
	}
	switch m.router.Mode() {
	case routingDirect:
		conn, resp, err := m.dialer.DialContext(ctx, rawURL, header)
		if err != nil && isDNSFailure(err) {
			log.Printf("[ws-proxy] cached direct routing hit DNS failure, demoting to service-proxy: host=%s err=%v",
				svc.namespace+"/"+svc.name, err)
			m.router.SetMode(routingProxy)
			return m.dialViaServiceProxy(ctx, svc, header)
		}
		return conn, resp, err
	case routingProxy:
		return m.dialViaServiceProxy(ctx, svc, header)
	}
	conn, resp, err := m.dialer.DialContext(ctx, rawURL, header)
	if err == nil {
		log.Printf("[ws-proxy] in-cluster direct dial works, caching routing=direct (24h TTL)")
		m.router.SetMode(routingDirect)
		return conn, resp, nil
	}
	if !isDNSFailure(err) {
		return nil, resp, err
	}
	log.Printf("[ws-proxy] in-cluster direct dial failed (DNS), caching routing=service-proxy (24h TTL): host=%s err=%v",
		svc.namespace+"/"+svc.name, err)
	m.router.SetMode(routingProxy)
	return m.dialViaServiceProxy(ctx, svc, header)
}

// dialViaServiceProxy opens a WebSocket through the K8s API
// server's service-proxy subresource.
func (m *WSManager) dialViaServiceProxy(
	ctx context.Context, svc *inClusterService, baseHeader http.Header,
) (*websocket.Conn, *http.Response, error) {
	if m.apiTLS == nil {
		return nil, nil, errors.New("service-proxy WS fallback unavailable: missing api TLS config")
	}
	apiURL, err := url.Parse(m.k8sCfg.Host)
	if err != nil {
		return nil, nil, fmt.Errorf("parse api host: %w", err)
	}
	wsScheme := "wss"
	if apiURL.Scheme == "http" {
		wsScheme = "ws"
	}
	path := strings.TrimPrefix(svc.path, "/")
	target := url.URL{
		Scheme:   wsScheme,
		Host:     apiURL.Host,
		Path:     fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%s/proxy/%s", svc.namespace, svc.name, svc.port, path),
		RawQuery: svc.query.Encode(),
	}
	hdr := baseHeader.Clone()
	if hdr == nil {
		hdr = http.Header{}
	}
	if tok, terr := bearerTokenFromConfig(m.k8sCfg); terr != nil {
		return nil, nil, fmt.Errorf("read bearer token: %w", terr)
	} else if tok != "" {
		hdr.Set("Authorization", "Bearer "+tok)
	}
	dialer := *m.dialer
	dialer.TLSClientConfig = m.apiTLS
	return dialer.DialContext(ctx, target.String(), hdr)
}

func bearerTokenFromConfig(c *rest.Config) (string, error) {
	if c == nil {
		return "", nil
	}
	if c.BearerToken != "" {
		return c.BearerToken, nil
	}
	if c.BearerTokenFile != "" {
		b, err := os.ReadFile(c.BearerTokenFile)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	return "", nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "")
}
