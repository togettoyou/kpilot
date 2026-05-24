package store

import (
	"database/sql"
	"fmt"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var DB *gorm.DB

// DBStats returns a snapshot of the underlying sql.DB pool stats.
// Safe to call from any goroutine (sql.DBStats is captured via a
// driver-side mutex). Returns zero value when DB is not yet
// initialized (e.g. early diag snapshot before Init returns).
func DBStats() sql.DBStats {
	if DB == nil {
		return sql.DBStats{}
	}
	sqlDB, err := DB.DB()
	if err != nil {
		return sql.DBStats{}
	}
	return sqlDB.Stats()
}

func Init(dsn string) error {
	// Slow queries → Warn; failed queries → Error; ErrRecordNotFound
	// is filtered (intentional control flow in our Upsert helpers).
	// All output routed through pkg/log under module "gorm".
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: kplog.NewGormLogger(200 * time.Millisecond),
		// Map driver-level constraint violations to gorm.Err* sentinels
		// (ErrDuplicatedKey, ErrForeignKeyViolated, ...) so handlers can
		// translate them to user-facing error codes via errors.Is, instead
		// of string-matching the raw pq.Error message.
		TranslateError: true,
	})
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return fmt.Errorf("get underlying db: %w", err)
	}
	// Pool sized for realistic multi-cluster / multi-tab load: 50
	// clusters × 5 open tabs × per-handler 2-4 GORM queries comfortably
	// fits inside 100 with headroom. Previous 25-conn cap hit `sql:
	// connection refused` long before any individual query was slow.
	// MaxIdleConns at 20 keeps a working set warm without bleeding the
	// idle ones too aggressively on quiet periods.
	sqlDB.SetMaxOpenConns(100)
	sqlDB.SetMaxIdleConns(20)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	if err = db.AutoMigrate(
		&Cluster{}, &PluginBlob{}, &Plugin{}, &ClusterPlugin{},
		&Model{}, &APIKey{},
		&SystemSnapshot{}, &SystemLog{},
	); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}

	// Publish DB BEFORE seeding so seed helpers that touch the
	// package-level var (UpsertPluginBlob for local-chart builtins,
	// any future seed routines that reuse store/* getters) don't
	// trip the nil-pointer deref. Init runs synchronously at boot,
	// so no consumer can read store.DB before this function
	// returns — even if it returns an error the process exits and
	// nothing reads the half-initialized handle.
	DB = db

	if err := SeedBuiltinPlugins(db); err != nil {
		return fmt.Errorf("seed builtin plugins: %w", err)
	}

	if err := SeedBuiltinModels(db); err != nil {
		return fmt.Errorf("seed builtin models: %w", err)
	}

	return nil
}
