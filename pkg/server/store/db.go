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

	// The previous Plugin table mixed registry fields (type/version/values)
	// with per-cluster status (cluster_id/phase). The redesign splits them
	// into Plugin (registry) + PluginBlob + ClusterPlugin. AutoMigrate
	// can't reshape a primary key, so drop and recreate. This is dev-only;
	// production data will be handled by an explicit migration when we
	// have one.
	if db.Migrator().HasTable("plugins") {
		if hasOldShape, err := tableHasColumn(db, "plugins", "cluster_id"); err == nil && hasOldShape {
			if err := db.Migrator().DropTable("plugins"); err != nil {
				return fmt.Errorf("drop legacy plugins table: %w", err)
			}
		}
	}

	if err = db.AutoMigrate(&Cluster{}, &PluginBlob{}, &Plugin{}, &ClusterPlugin{}); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}

	if err := SeedBuiltinPlugins(db); err != nil {
		return fmt.Errorf("seed builtin plugins: %w", err)
	}

	DB = db
	return nil
}

// tableHasColumn returns true if the given column exists on the table. Used
// to detect the legacy plugins shape before AutoMigrate.
func tableHasColumn(db *gorm.DB, table, column string) (bool, error) {
	var count int64
	err := db.Raw(`SELECT COUNT(*) FROM information_schema.columns
		WHERE table_name = ? AND column_name = ?`, table, column).Scan(&count).Error
	if err != nil {
		return false, err
	}
	return count > 0, nil
}
