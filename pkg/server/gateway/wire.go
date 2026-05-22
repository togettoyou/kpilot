package gateway

import (
	"github.com/togettoyou/kpilot/pkg/common/proto"
	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
)

// Conversion helpers between the v1 proto types handlers use
// (gateway.HTTPHeader, etc) and the v2 wire types. Kept tiny + local
// so the wire boundary is the only place that knows both.

func headersToV2(h []*proto.HTTPHeader) []*pbv2.HTTPHeader {
	if len(h) == 0 {
		return nil
	}
	out := make([]*pbv2.HTTPHeader, len(h))
	for i, x := range h {
		out[i] = &pbv2.HTTPHeader{Name: x.GetName(), Value: x.GetValue()}
	}
	return out
}

func headersFromV2(h []*pbv2.HTTPHeader) []*proto.HTTPHeader {
	if len(h) == 0 {
		return nil
	}
	out := make([]*proto.HTTPHeader, len(h))
	for i, x := range h {
		out[i] = &proto.HTTPHeader{Name: x.GetName(), Value: x.GetValue()}
	}
	return out
}
