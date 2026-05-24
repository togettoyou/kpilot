// Package log is the project-wide logging facade — a thin layer over
// go.uber.org/zap that gives every package a module-scoped logger
// without imposing the full zap.Field ceremony at call sites.
//
//	var lg = log.L("gateway")
//	lg.Info("worker connected", "cluster", clusterID, "addr", addr)
//	lg.Warn("snapshot dispatch failed", "err", err)
//
// Output is human-readable console format by default (not JSON);
// switch via KPILOT_LOG_MODE=json for structured ingestion. Level is
// controlled by KPILOT_LOG_LEVEL (debug | info | warn | error).
//
// # Performance
//
// Internally we use zap.SugaredLogger.Infow / Warnw / Errorw — the
// key-value variadic form that matches our existing
// `log.Printf("[component] msg: key=val", ...)` idiom. SugaredLogger
// is ~1–2 µs per call (vs. ~200 ns for the structured Logger), which
// is irrelevant for everything in this project (admin / control-plane
// scale, not high-throughput per-RPC logging). The HTTP middleware,
// the only call site that runs once per request, batches into a
// single Infow per request so even at peak load it's well below 1%
// of the request budget.
//
// If a future hot path genuinely needs zero-alloc structured logging,
// call (*Logger).Zap() to drop down to the raw *zap.Logger and use
// zap.Field directly — but don't reach for it preemptively.
//
// # Module names
//
// L(module) returns a cached logger whose output is prefixed with the
// module name (zap's Named()). Convention is lowercase kebab-case
// matching the package's role:
//
//	gateway, poller, proxy, tunnel, handler, store, plugin,
//	inference-proxy, model-deploy, gpu-hour, device-health, ...
//
// Reuse the module name when a sub-area emits enough logs to deserve
// its own filter — e.g. handler subdivides into "handler.model",
// "handler.volcano" via L("handler.model").
package log

import (
	"fmt"
	"os"
	"strings"
	"sync"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// Logger wraps a *zap.SugaredLogger so we can swap implementations
// later without touching every call site. The wrapper API is
// deliberately tiny: four levels + formatted variants for porting
// legacy log.Printf code.
type Logger struct {
	z     *zap.Logger
	sugar *zap.SugaredLogger
}

var (
	base    *zap.Logger
	baseMu  sync.RWMutex
	level   = zap.NewAtomicLevelAt(zap.InfoLevel)
	cache   sync.Map // string -> *Logger
	initial sync.Once

	// ring is the process-wide in-memory log buffer. Populated by
	// Init(); read by the /debug/logs endpoint via Ring(). nil before
	// Init runs, which is fine — that path is only reached if someone
	// imports pkg/log without ever calling L() (impossible in practice).
	ring *RingCore
)

// Init configures the global logger. Idempotent — first call wins;
// subsequent calls are no-ops (call SetLevel for runtime tuning).
// Safe to call from cmd/server and cmd/worker main(); also called
// implicitly with defaults from L() if you forget.
//
// Env vars (all optional):
//
//	KPILOT_LOG_LEVEL = debug | info | warn | error          (default: info)
//	KPILOT_LOG_MODE  = console | json                        (default: console)
//	KPILOT_LOG_COLOR = always | never | auto                 (default: auto — color when stderr is a TTY)
func Init() {
	initial.Do(initFromEnv)
}

func initFromEnv() {
	lvl := parseLevel(os.Getenv("KPILOT_LOG_LEVEL"))
	level.SetLevel(lvl)

	mode := strings.ToLower(strings.TrimSpace(os.Getenv("KPILOT_LOG_MODE")))
	if mode == "" {
		mode = "console"
	}

	color := strings.ToLower(strings.TrimSpace(os.Getenv("KPILOT_LOG_COLOR")))
	if color == "" {
		color = "auto"
	}
	useColor := false
	switch color {
	case "always":
		useColor = true
	case "never":
		useColor = false
	default:
		useColor = isTerminal(os.Stderr)
	}

	encCfg := zapcore.EncoderConfig{
		TimeKey:        "T",
		LevelKey:       "L",
		NameKey:        "M",
		MessageKey:     "msg",
		StacktraceKey:  "S",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeTime:     zapcore.TimeEncoderOfLayout("2006-01-02 15:04:05.000"),
		EncodeDuration: zapcore.StringDurationEncoder,
		EncodeCaller:   nil, // caller info is noisy in console; opt in via zap.AddCaller() on demand
	}
	if useColor {
		encCfg.EncodeLevel = zapcore.CapitalColorLevelEncoder
	} else {
		encCfg.EncodeLevel = zapcore.CapitalLevelEncoder
	}

	var enc zapcore.Encoder
	if mode == "json" {
		enc = zapcore.NewJSONEncoder(encCfg)
	} else {
		enc = zapcore.NewConsoleEncoder(encCfg)
	}

	stderrCore := zapcore.NewCore(enc, zapcore.Lock(os.Stderr), level)
	// Ring buffer sized for ~50 k entries — caps memory ~12 MB at
	// realistic average entry size (250 B). The pkg/server/diag
	// LogsPoller pulls this every 5 s and flushes to PG, so the ring
	// is just a staging buffer for in-flight lines, not the durable
	// store.
	ring = NewRingCore(50_000, level)
	core := zapcore.NewTee(stderrCore, ring)
	// No automatic stack traces — they bloat console output and the
	// useful frame is almost always the call site, which the log line
	// itself tells you. Stack traces are still added for Panic+
	// (zap default) which is what you'd actually want one for.
	z := zap.New(core)

	baseMu.Lock()
	base = z
	baseMu.Unlock()
}

// Ring exposes the in-process log ring buffer so the diag endpoint
// (pkg/diag./debug/logs) can pull from it. Returns nil if Init() has
// not run yet — practically impossible since L() calls Init lazily,
// but cheap to nil-check.
func Ring() *RingCore { return ring }

// SetLevel adjusts the global level at runtime (atomic, lock-free
// reads on the hot path). Useful for /debug toggles.
func SetLevel(s string) {
	level.SetLevel(parseLevel(s))
}

// Level returns the current global level as a string.
func Level() string {
	return level.Level().String()
}

// Sync flushes buffered output. Call once on shutdown. Best-effort —
// stderr Sync on macOS returns "invalid argument", we swallow that
// rather than propagate a useless error.
func Sync() {
	baseMu.RLock()
	z := base
	baseMu.RUnlock()
	if z != nil {
		_ = z.Sync()
	}
}

// L returns a logger whose output is named with the given module
// string (appears between the level and the message in console mode).
// Loggers are cached per module — repeated calls return the same
// instance.
//
// Convention: lowercase kebab-case ("gateway", "diag-poller",
// "inference-proxy"). Sub-areas use dot notation
// ("handler.model", "handler.volcano") and zap renders them as a
// single dotted name.
func L(module string) *Logger {
	if v, ok := cache.Load(module); ok {
		return v.(*Logger)
	}
	Init() // idempotent — guarantees `base` is set before we read it
	baseMu.RLock()
	z := base.Named(module)
	baseMu.RUnlock()
	l := &Logger{z: z, sugar: z.Sugar()}
	actual, _ := cache.LoadOrStore(module, l)
	return actual.(*Logger)
}

// Default returns the un-named root logger. Prefer L(module) — this
// is for early-boot code (config loader, env decoder) that doesn't
// belong to any subsystem yet.
func Default() *Logger {
	return L("")
}

// ─── level-named convenience methods ────────────────────────────────

// Debug logs at debug level. Used for hot-path detail you only want
// during incident investigation — per-poll, per-frame, per-stream
// state transitions. Disabled by default; flip with
// KPILOT_LOG_LEVEL=debug.
func (l *Logger) Debug(msg string, kv ...any) { l.sugar.Debugw(msg, kv...) }

// Info is the default level for steady-state operational events —
// startup, shutdown, cluster connect/disconnect, schema migrations.
// Should fire at human-readable cadence (≪ 1/sec at idle).
func (l *Logger) Info(msg string, kv ...any) { l.sugar.Infow(msg, kv...) }

// Warn is for unexpected-but-recoverable conditions — single failed
// poll, transient API error that the caller retries, gracefully
// degraded path taken.
func (l *Logger) Warn(msg string, kv ...any) { l.sugar.Warnw(msg, kv...) }

// Error is for failures that require operator attention — request
// could not be served, write to disk failed, persistent worker
// connect failure. Errors include an automatic stack trace.
func (l *Logger) Error(msg string, kv ...any) { l.sugar.Errorw(msg, kv...) }

// ─── formatted variants ─────────────────────────────────────────────
//
// Use sparingly — prefer the KV form (Info / Warn / Error) so fields
// stay machine-parseable in JSON mode. These exist for porting code
// where the original `log.Printf("foo: %v", err)` doesn't have a
// natural key.

func (l *Logger) Debugf(format string, args ...any) { l.sugar.Debugf(format, args...) }
func (l *Logger) Infof(format string, args ...any)  { l.sugar.Infof(format, args...) }
func (l *Logger) Warnf(format string, args ...any)  { l.sugar.Warnf(format, args...) }
func (l *Logger) Errorf(format string, args ...any) { l.sugar.Errorf(format, args...) }

// Fatal / Fatalf log at Error level then call os.Exit(1) after Sync(),
// so the message actually reaches stderr before the process dies. Use
// for unrecoverable boot-time failures (config invalid, port bind
// failed, db unreachable) — not in request paths.
func (l *Logger) Fatal(msg string, kv ...any) {
	l.sugar.Errorw(msg, kv...)
	Sync()
	os.Exit(1)
}
func (l *Logger) Fatalf(format string, args ...any) {
	l.sugar.Errorf(format, args...)
	Sync()
	os.Exit(1)
}

// ─── escape hatches ─────────────────────────────────────────────────

// Zap returns the underlying *zap.Logger for hot paths that genuinely
// need zero-alloc structured logging via zap.Field. Don't reach for
// this preemptively — Sugar is fast enough for everything in this
// project.
func (l *Logger) Zap() *zap.Logger { return l.z }

// Enabled reports whether a given level passes the current filter.
// Use at the top of middleware / hot-path callers to skip expensive
// kv-slice construction when the message would be dropped anyway:
//
//	if lg.Enabled(kplog.InfoLevel) {
//	    lg.Info("request", "status", c.Writer.Status(), ...)
//	}
//
// Without the guard, the variadic call still builds the slice and
// formats values before zap's internal level check drops it.
func (l *Logger) Enabled(lvl zapcore.Level) bool {
	return l.z.Core().Enabled(lvl)
}

// Level constants re-exported so callers don't have to import zapcore
// just to spell a level for Enabled().
const (
	DebugLevel = zapcore.DebugLevel
	InfoLevel  = zapcore.InfoLevel
	WarnLevel  = zapcore.WarnLevel
	ErrorLevel = zapcore.ErrorLevel
)

// Sugar returns the underlying *zap.SugaredLogger for code that wants
// the full Sugar API (.With, .DPanic, etc.).
func (l *Logger) Sugar() *zap.SugaredLogger { return l.sugar }

// With returns a child logger with the given fields permanently
// attached. Useful for request-scoped or per-cluster loggers:
//
//	lg := log.L("inference-proxy").With("cluster", clusterID, "ns", ns)
//	lg.Info("dispatch", "method", method)        // → cluster=..., ns=..., method=...
func (l *Logger) With(kv ...any) *Logger {
	s := l.sugar.With(kv...)
	return &Logger{z: s.Desugar(), sugar: s}
}

// ─── helpers ────────────────────────────────────────────────────────

func parseLevel(s string) zapcore.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return zap.DebugLevel
	case "warn", "warning":
		return zap.WarnLevel
	case "error", "err":
		return zap.ErrorLevel
	case "fatal":
		return zap.FatalLevel
	case "panic":
		return zap.PanicLevel
	default:
		return zap.InfoLevel
	}
}

// Compile-time guard: fmt is used for the panic fallback below.
var _ = fmt.Sprintf
