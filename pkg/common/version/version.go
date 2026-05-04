package version

// Version is the kpilot release version. Override at build time with:
//
//	go build -ldflags "-X github.com/togettoyou/kpilot/pkg/common/version.Version=v0.2.0" ...
var Version = "v0.1.0"
