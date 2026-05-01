package store

import (
	"time"
)

type ClusterStatus string

const (
	ClusterStatusOffline ClusterStatus = "offline"
	ClusterStatusOnline  ClusterStatus = "online"
)

type Cluster struct {
	ID          string        `gorm:"primaryKey;type:varchar(36)" json:"id"`
	Name        string        `gorm:"type:varchar(255);not null;uniqueIndex" json:"name"`
	Token       string        `gorm:"type:varchar(255);not null;uniqueIndex" json:"-"`
	Status      ClusterStatus `gorm:"type:varchar(20);not null;default:'offline'" json:"status"`
	Description string        `gorm:"type:text" json:"description"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
}

type PluginPhase string

const (
	PluginPhasePending    PluginPhase = "Pending"
	PluginPhaseInstalling PluginPhase = "Installing"
	PluginPhaseRunning    PluginPhase = "Running"
	PluginPhaseFailed     PluginPhase = "Failed"
)

type Plugin struct {
	ID        uint        `gorm:"primaryKey;autoIncrement" json:"id"`
	ClusterID string      `gorm:"type:varchar(36);not null;index" json:"cluster_id"`
	Type      string      `gorm:"type:varchar(64);not null" json:"type"`
	Version   string      `gorm:"type:varchar(64)" json:"version"`
	Phase     PluginPhase `gorm:"type:varchar(20);not null;default:'Pending'" json:"phase"`
	Message   string      `gorm:"type:text" json:"message"`
	Values    []byte      `gorm:"type:jsonb" json:"values"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}
