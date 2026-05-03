package plugin

import (
	"k8s.io/client-go/rest"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// clientcmdRawConfigFromRest builds a clientcmd raw config that mirrors a
// runtime *rest.Config. It's used so Helm's action.Configuration can call
// ToRawKubeConfigLoader().Namespace() without us ever writing a kubeconfig
// file to disk.
//
// Only the bits Helm actually reads are populated:
//   - the cluster's API server URL + CA / TLS data
//   - a placeholder authinfo derived from rest.Config's bearer token /
//     client cert / impersonation (best-effort — Helm itself talks to the
//     API server via rest.Config, this is purely for namespace lookup)
//   - the chosen namespace as the default context
func clientcmdRawConfigFromRest(cfg *rest.Config, namespace string) clientcmdapi.Config {
	const ctxName = "kpilot-worker"
	const userName = "kpilot-worker-user"

	cluster := &clientcmdapi.Cluster{
		Server:                   cfg.Host,
		InsecureSkipTLSVerify:    cfg.Insecure,
		CertificateAuthority:     cfg.CAFile,
		CertificateAuthorityData: append([]byte(nil), cfg.CAData...),
	}
	auth := &clientcmdapi.AuthInfo{
		Token:             cfg.BearerToken,
		TokenFile:         cfg.BearerTokenFile,
		ClientCertificate: cfg.CertFile,
		ClientKey:         cfg.KeyFile,
	}
	if len(cfg.CertData) > 0 {
		auth.ClientCertificateData = append([]byte(nil), cfg.CertData...)
	}
	if len(cfg.KeyData) > 0 {
		auth.ClientKeyData = append([]byte(nil), cfg.KeyData...)
	}
	return clientcmdapi.Config{
		Clusters:  map[string]*clientcmdapi.Cluster{ctxName: cluster},
		AuthInfos: map[string]*clientcmdapi.AuthInfo{userName: auth},
		Contexts: map[string]*clientcmdapi.Context{
			ctxName: {
				Cluster:   ctxName,
				AuthInfo:  userName,
				Namespace: namespace,
			},
		},
		CurrentContext: ctxName,
	}
}
