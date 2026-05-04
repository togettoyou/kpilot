package plugin

import (
	"context"
	"fmt"

	apiextv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apiextclient "k8s.io/apiextensions-apiserver/pkg/client/clientset/clientset"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"

	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// EnsurePluginCRD installs (or updates) the Plugin CRD definition on the
// target cluster. Called once on Worker startup, before the reconciler
// starts watching, so the Watch never trips on "no kind registered".
//
// We don't ship a separate Helm chart for the Worker yet (per design),
// so the CRD has to be auto-installed. When a Helm chart lands later,
// this can become a no-op (or a sanity check + version assertion).
func EnsurePluginCRD(ctx context.Context, cfg *rest.Config) error {
	cs, err := apiextclient.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("apiext client: %w", err)
	}

	desired := pluginCRD()
	existing, err := cs.ApiextensionsV1().CustomResourceDefinitions().
		Get(ctx, desired.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = cs.ApiextensionsV1().CustomResourceDefinitions().
			Create(ctx, desired, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return fmt.Errorf("get crd: %w", err)
	}
	// Update only the spec — preserve metadata (resource version, labels
	// the operator might care about).
	existing.Spec = desired.Spec
	_, err = cs.ApiextensionsV1().CustomResourceDefinitions().
		Update(ctx, existing, metav1.UpdateOptions{})
	return err
}

// pluginCRD returns the canonical Plugin CRD definition. Schema is left
// open (x-kubernetes-preserve-unknown-fields) — the API contract lives
// in the proto + Go types; loose schema avoids needing controller-gen
// in the build pipeline.
func pluginCRD() *apiextv1.CustomResourceDefinition {
	preserve := true
	openSchema := &apiextv1.JSONSchemaProps{
		Type:                   "object",
		XPreserveUnknownFields: &preserve,
	}
	return &apiextv1.CustomResourceDefinition{
		ObjectMeta: metav1.ObjectMeta{
			Name: "plugins." + kpilotv1alpha1.GroupName,
		},
		Spec: apiextv1.CustomResourceDefinitionSpec{
			Group: kpilotv1alpha1.GroupName,
			Names: apiextv1.CustomResourceDefinitionNames{
				Plural:     "plugins",
				Singular:   "plugin",
				Kind:       "Plugin",
				ShortNames: []string{"kpl"},
			},
			Scope: apiextv1.ClusterScoped,
			Versions: []apiextv1.CustomResourceDefinitionVersion{
				{
					Name:    "v1alpha1",
					Served:  true,
					Storage: true,
					Schema: &apiextv1.CustomResourceValidation{
						OpenAPIV3Schema: openSchema,
					},
					Subresources: &apiextv1.CustomResourceSubresources{
						Status: &apiextv1.CustomResourceSubresourceStatus{},
					},
					AdditionalPrinterColumns: []apiextv1.CustomResourceColumnDefinition{
						// Source instead of Chart name — chart.name is
						// only populated for chart_type=repo. OCI charts
						// put the whole reference in chart.repo and
						// leave name empty; local charts use sha256 in
						// chart.sha256. chart.type is the only field
						// that's always set, so it gives every plugin
						// a non-empty Source value.
						{Name: "Source", Type: "string", JSONPath: ".spec.chart.type"},
						{Name: "Namespace", Type: "string", JSONPath: ".spec.release.namespace"},
						{Name: "Phase", Type: "string", JSONPath: ".status.phase"},
						{Name: "Version", Type: "string", JSONPath: ".status.observedVersion"},
						{Name: "Age", Type: "date", JSONPath: ".metadata.creationTimestamp"},
					},
				},
			},
		},
	}
}
