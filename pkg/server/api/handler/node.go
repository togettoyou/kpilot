package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

type NodeResponse struct {
	Name               string            `json:"name"`
	Status             string            `json:"status"`
	CPUCapacity        int64             `json:"cpu_capacity"`        // millicores
	CPUAllocatable     int64             `json:"cpu_allocatable"`     // millicores
	MemoryCapacity     int64             `json:"memory_capacity"`     // bytes
	MemoryAllocatable  int64             `json:"memory_allocatable"`  // bytes
	Labels             map[string]string `json:"labels"`
}

func ListNodes(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		nodes := gw.GetNodes(clusterID)
		resp := make([]NodeResponse, 0, len(nodes))
		for _, n := range nodes {
			resp = append(resp, toNodeResponse(n))
		}
		c.JSON(http.StatusOK, resp)
	}
}

func toNodeResponse(n *proto.NodeInfo) NodeResponse {
	return NodeResponse{
		Name:              n.Name,
		Status:            n.Status,
		CPUCapacity:       n.CpuCapacity,
		CPUAllocatable:    n.CpuAllocatable,
		MemoryCapacity:    n.MemoryCapacity,
		MemoryAllocatable: n.MemoryAllocatable,
		Labels:            n.Labels,
	}
}
