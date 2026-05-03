package store

import (
	"time"

	"gorm.io/gorm"
)

func CreateCluster(cluster *Cluster) error {
	return DB.Create(cluster).Error
}

func GetClusterByID(id string) (*Cluster, error) {
	var c Cluster
	if err := DB.Where("id = ?", id).First(&c).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

func GetClusterByToken(token string) (*Cluster, error) {
	var c Cluster
	if err := DB.Where("token = ?", token).First(&c).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

func ListClusters() ([]Cluster, error) {
	var clusters []Cluster
	if err := DB.Order("created_at desc").Find(&clusters).Error; err != nil {
		return nil, err
	}
	return clusters, nil
}

func DeleteCluster(id string) error {
	// Cascade ClusterPlugin rows for this cluster — leaving them as
	// orphans (FK pointing at a missing cluster row) breaks downstream
	// joins and silently loses track of any Helm releases the deleted
	// cluster might still have if it ever reconnects under a fresh
	// token. Built-in/custom plugin rows in `plugins` are untouched.
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("cluster_id = ?", id).Delete(&ClusterPlugin{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", id).Delete(&Cluster{}).Error
	})
}

func UpdateClusterStatus(id string, status ClusterStatus) error {
	return DB.Model(&Cluster{}).Where("id = ?", id).Update("status", status).Error
}

func UpdateCluster(id, name, description string) error {
	return DB.Model(&Cluster{}).Where("id = ?", id).Updates(map[string]any{
		"name":        name,
		"description": description,
		"updated_at":  time.Now(),
	}).Error
}

func UpdateClusterToken(id, token string) error {
	return DB.Model(&Cluster{}).Where("id = ?", id).Update("token", token).Error
}

func ResetAllClustersOffline() error {
	return DB.Model(&Cluster{}).Where("status = ?", ClusterStatusOnline).Update("status", ClusterStatusOffline).Error
}

func ClusterExists(name string) (bool, error) {
	var count int64
	if err := DB.Model(&Cluster{}).Where("name = ?", name).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

var ErrClusterNotFound = gorm.ErrRecordNotFound
