package store

import "gorm.io/gorm"

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
	return DB.Where("id = ?", id).Delete(&Cluster{}).Error
}

func UpdateClusterStatus(id string, status ClusterStatus) error {
	return DB.Model(&Cluster{}).Where("id = ?", id).Update("status", status).Error
}

func ClusterExists(name string) (bool, error) {
	var count int64
	if err := DB.Model(&Cluster{}).Where("name = ?", name).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

var ErrClusterNotFound = gorm.ErrRecordNotFound
