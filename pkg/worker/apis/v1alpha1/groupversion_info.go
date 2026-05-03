// Package v1alpha1 contains API Schema definitions for the kpilot.io
// v1alpha1 API group, currently the Plugin CRD.
//
// +groupName=kpilot.io
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

// GroupName is the API group used by the kpilot CRDs.
const GroupName = "kpilot.io"

// GroupVersion is the API group/version this package describes.
var GroupVersion = schema.GroupVersion{Group: GroupName, Version: "v1alpha1"}

// SchemeBuilder collects the type registrations to add to a runtime.Scheme.
var SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

// AddToScheme registers the v1alpha1 types with the given Scheme.
var AddToScheme = SchemeBuilder.AddToScheme

func init() {
	SchemeBuilder.Register(&Plugin{}, &PluginList{})
}
