package store

import (
	"fmt"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

func Init(dsn string) error {
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	if err = db.AutoMigrate(&Cluster{}, &Plugin{}); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	DB = db
	return nil
}
