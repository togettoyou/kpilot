package log

import (
	"time"

	"github.com/gin-gonic/gin"
)

// GinMiddleware logs one line per request via the "gin" module logger.
// Replaces gin.Logger() (the colored stdout writer) so all framework
// output goes through our pipeline — same time format, same module
// prefix, same level filter.
//
// Fields:
//
//	status  int    — HTTP status code
//	method  string — GET / POST / ...
//	path    string — request path (raw, no query — query lives below)
//	query   string — raw query string (omitted if empty)
//	ip      string — client IP per gin.Context.ClientIP()
//	latency string — human-readable duration
//	bytes   int    — response body size
//	err     string — last error from gin.Context.Errors (omitted if empty)
//
// Level selection: 5xx → Error; 4xx → Warn; otherwise Info. Health-
// check noise can be filtered by passing SkipPaths.
func GinMiddleware(skipPaths ...string) gin.HandlerFunc {
	skip := make(map[string]struct{}, len(skipPaths))
	for _, p := range skipPaths {
		skip[p] = struct{}{}
	}
	lg := L("gin")
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		if _, ok := skip[path]; ok {
			c.Next()
			return
		}
		query := c.Request.URL.RawQuery

		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		kv := []any{
			"status", status,
			"method", c.Request.Method,
			"path", path,
			"ip", c.ClientIP(),
			"latency", latency.String(),
			"bytes", c.Writer.Size(),
		}
		if query != "" {
			kv = append(kv, "query", query)
		}
		if errs := c.Errors.ByType(gin.ErrorTypePrivate).String(); errs != "" {
			kv = append(kv, "err", errs)
		}

		switch {
		case status >= 500:
			lg.Error("request", kv...)
		case status >= 400:
			lg.Warn("request", kv...)
		default:
			lg.Info("request", kv...)
		}
	}
}

// GinRecovery is a recover middleware that funnels panics through our
// logger (preserving the stack) instead of gin's default handler.
// Use with gin.New() — gin.Default() bundles its own Recovery and
// Logger that we're replacing wholesale.
func GinRecovery() gin.HandlerFunc {
	lg := L("gin")
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				lg.Errorf("panic: %v", r)
				c.AbortWithStatus(500)
			}
		}()
		c.Next()
	}
}
