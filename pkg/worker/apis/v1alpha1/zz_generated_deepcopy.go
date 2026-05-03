// DeepCopy code for the v1alpha1 types. Hand-written to avoid wiring
// controller-gen into the build; small enough that drift is easy to spot.
// Match the shape produced by `controller-gen object` so future migration
// to generated code is mechanical.

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// ─── ChartSource ─────────────────────────────────────────────────────────

func (in *ChartSource) DeepCopyInto(out *ChartSource) {
	*out = *in
}

func (in *ChartSource) DeepCopy() *ChartSource {
	if in == nil {
		return nil
	}
	out := new(ChartSource)
	in.DeepCopyInto(out)
	return out
}

// ─── ReleaseSpec ─────────────────────────────────────────────────────────

func (in *ReleaseSpec) DeepCopyInto(out *ReleaseSpec) {
	*out = *in
}

func (in *ReleaseSpec) DeepCopy() *ReleaseSpec {
	if in == nil {
		return nil
	}
	out := new(ReleaseSpec)
	in.DeepCopyInto(out)
	return out
}

// ─── PluginSpec ──────────────────────────────────────────────────────────

func (in *PluginSpec) DeepCopyInto(out *PluginSpec) {
	*out = *in
	in.Chart.DeepCopyInto(&out.Chart)
	in.Release.DeepCopyInto(&out.Release)
}

func (in *PluginSpec) DeepCopy() *PluginSpec {
	if in == nil {
		return nil
	}
	out := new(PluginSpec)
	in.DeepCopyInto(out)
	return out
}

// ─── PluginStatus ────────────────────────────────────────────────────────

func (in *PluginStatus) DeepCopyInto(out *PluginStatus) {
	*out = *in
	if in.InstalledAt != nil {
		out.InstalledAt = in.InstalledAt.DeepCopy()
	}
	if in.LastUpdatedAt != nil {
		out.LastUpdatedAt = in.LastUpdatedAt.DeepCopy()
	}
	if in.Conditions != nil {
		out.Conditions = make([]metav1.Condition, len(in.Conditions))
		for i := range in.Conditions {
			in.Conditions[i].DeepCopyInto(&out.Conditions[i])
		}
	}
}

func (in *PluginStatus) DeepCopy() *PluginStatus {
	if in == nil {
		return nil
	}
	out := new(PluginStatus)
	in.DeepCopyInto(out)
	return out
}

// ─── Plugin ──────────────────────────────────────────────────────────────

func (in *Plugin) DeepCopyInto(out *Plugin) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}

func (in *Plugin) DeepCopy() *Plugin {
	if in == nil {
		return nil
	}
	out := new(Plugin)
	in.DeepCopyInto(out)
	return out
}

func (in *Plugin) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

// ─── PluginList ──────────────────────────────────────────────────────────

func (in *PluginList) DeepCopyInto(out *PluginList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]Plugin, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *PluginList) DeepCopy() *PluginList {
	if in == nil {
		return nil
	}
	out := new(PluginList)
	in.DeepCopyInto(out)
	return out
}

func (in *PluginList) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}
