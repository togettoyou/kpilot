package store

import (
	"fmt"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

func Init(dsn string) error {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
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

	if err = db.AutoMigrate(&Cluster{}, &PluginBlob{}, &Plugin{}, &ClusterPlugin{}, &Model{}, &APIKey{}); err != nil {
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
