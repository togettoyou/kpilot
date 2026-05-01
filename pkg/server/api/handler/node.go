package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

type NodeResponse struct {
	Name              string            `json:"name"`
	Status            string            `json:"status"`
	CPUCapacity       int64             `json:"cpu_capacity"`       // millicores
	CPUAllocatable    int64             `json:"cpu_allocatable"`    // millicores
	MemoryCapacity    int64             `json:"memory_capacity"`    // bytes
	MemoryAllocatable int64             `json:"memory_allocatable"` // bytes
	Labels            map[string]string `json:"labels"`
	Annotations       map[string]string `json:"annotations"`
	OSImage           string            `json:"os_image"`
	KernelVersion     string            `json:"kernel_version"`
	ContainerRuntime  string            `json:"container_runtime"`
	KubeletVersion    string            `json:"kubelet_version"`
	InternalIP        string            `json:"internal_ip"`
	PodCIDR           string            `json:"pod_cidr"`
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

// noisyAnnotations are annotations that are too large or low-value to surface in the UI.
var noisyAnnotations = map[string]bool{
	"kubectl.kubernetes.io/last-applied-configuration": true,
}

func toNodeResponse(n *proto.NodeInfo) NodeResponse {
	annotations := make(map[string]string, len(n.Annotations))
	for k, v := range n.Annotations {
		if !noisyAnnotations[k] {
			annotations[k] = v
		}
	}
	return NodeResponse{
		Name:              n.Name,
		Status:            n.Status,
		CPUCapacity:       n.CpuCapacity,
		CPUAllocatable:    n.CpuAllocatable,
		MemoryCapacity:    n.MemoryCapacity,
		MemoryAllocatable: n.MemoryAllocatable,
		Labels:            n.Labels,
		Annotations:       annotations,
		OSImage:           n.OsImage,
		KernelVersion:     n.KernelVersion,
		ContainerRuntime:  n.ContainerRuntime,
		KubeletVersion:    n.KubeletVersion,
		InternalIP:        n.InternalIp,
		PodCIDR:           n.PodCidr,
	}
}
