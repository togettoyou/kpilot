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

	if err := SeedBuiltinPlugins(db); err != nil {
		return fmt.Errorf("seed builtin plugins: %w", err)
	}

	DB = db
	return nil
}
