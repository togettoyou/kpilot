package log

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// NewGormLogger returns a gorm.io/gorm/logger.Interface backed by our
// zap wrapper. Messages land under the module name "gorm".
//
// Mapping:
//   - GORM Info  → Logger.Info  (used for AutoMigrate boilerplate; quiet by default)
//   - GORM Warn  → Logger.Warn
//   - GORM Error → Logger.Error
//   - Trace      → on slow queries (> slowThreshold) we emit a Warn with elapsed/rows;
//                  failed queries emit Error; ErrRecordNotFound is filtered (those are
//                  intentional control flow in our Upsert helpers).
//
// slowThreshold defaults to 200ms — same value the previous handcrafted
// gorm logger used. Pass 0 to disable slow-query logging.
func NewGormLogger(slowThreshold time.Duration) gormlogger.Interface {
	if slowThreshold == 0 {
		slowThreshold = 200 * time.Millisecond
	}
	return &gormZap{
		lg:    L("gorm"),
		slow:  slowThreshold,
		level: gormlogger.Warn,
	}
}

type gormZap struct {
	lg    *Logger
	slow  time.Duration
	level gormlogger.LogLevel
}

func (g *gormZap) LogMode(level gormlogger.LogLevel) gormlogger.Interface {
	cp := *g
	cp.level = level
	return &cp
}

func (g *gormZap) Info(_ context.Context, msg string, args ...any) {
	if g.level < gormlogger.Info {
		return
	}
	g.lg.Infof(msg, args...)
}

func (g *gormZap) Warn(_ context.Context, msg string, args ...any) {
	if g.level < gormlogger.Warn {
		return
	}
	g.lg.Warnf(msg, args...)
}

func (g *gormZap) Error(_ context.Context, msg string, args ...any) {
	if g.level < gormlogger.Error {
		return
	}
	g.lg.Errorf(msg, args...)
}

func (g *gormZap) Trace(_ context.Context, begin time.Time, fc func() (string, int64), err error) {
	if g.level <= gormlogger.Silent {
		return
	}
	elapsed := time.Since(begin)
	// ErrRecordNotFound is intentional in our Upsert flow ("look up,
	// INSERT if absent"). Don't pollute the log on every miss.
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) && g.level >= gormlogger.Error {
		sql, rows := fc()
		g.lg.Error("query error",
			"err", err,
			"elapsed_ms", elapsed.Milliseconds(),
			"rows", rows,
			"sql", sql,
		)
		return
	}
	if g.slow > 0 && elapsed > g.slow && g.level >= gormlogger.Warn {
		sql, rows := fc()
		g.lg.Warn("slow query",
			"elapsed_ms", elapsed.Milliseconds(),
			"threshold_ms", g.slow.Milliseconds(),
			"rows", rows,
			"sql", sql,
		)
	}
}
