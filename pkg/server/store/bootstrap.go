package store

import (
	"errors"
	"log"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// BootstrapLocalCluster creates a cluster row with the given (name, token)
// on first start, so a single-release helm install (server + worker in
// the same cluster) doesn't require the admin to click through the UI
// to create the cluster before the worker can register.
//
// Idempotent: a row with the same NAME is considered "already
// bootstrapped" and the call no-ops. This preserves any later edits
// the admin may have made via UI — including a regenerated token,
// which is the supported way to rotate. Operators who want the
// bootstrap to "win" must delete the row first.
//
// description is the row's free-text description; kept short so the UI
// list looks clean.
func BootstrapLocalCluster(name, token, description string) error {
	if name == "" || token == "" {
		return errors.New("bootstrap: name and token are required")
	}
	var existing Cluster
	err := DB.Where("name = ?", name).First(&existing).Error
	if err == nil {
		// Row already exists — silently keep it. Log at info so the
		// operator can correlate "worker registration failed because
		// token doesn't match" with the boot-time message.
		log.Printf("[bootstrap] cluster %q already exists (id=%s), skipping local-cluster bootstrap",
			name, existing.ID)
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	cluster := &Cluster{
		ID:          uuid.New().String(),
		Name:        name,
		Token:       token,
		Status:      ClusterStatusOffline,
		Description: description,
	}
	if err := CreateCluster(cluster); err != nil {
		// Race window: another server replica might have inserted the
		// same name concurrently. Detect via GORM's translated duplicate-
		// key sentinel and downgrade to the same "already exists" no-op.
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			log.Printf("[bootstrap] cluster %q raced to insert, skipping", name)
			return nil
		}
		return err
	}
	log.Printf("[bootstrap] created local cluster: name=%s id=%s", name, cluster.ID)
	return nil
}
