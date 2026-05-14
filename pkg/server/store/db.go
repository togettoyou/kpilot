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
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	if err = db.AutoMigrate(&Cluster{}, &PluginBlob{}, &Plugin{}, &ClusterPlugin{}); err != nil {
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

	return nil
}
