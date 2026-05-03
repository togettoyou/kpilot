package store

import (
	"errors"

	"gorm.io/gorm"
)

// builtin lists the plugins we ship out of the box. They are seeded on
// startup if absent and refreshed on every boot if the row exists, since
// `is_builtin=true` plugins are immutable from the user's perspective —
// they shouldn't drift from the values defined here.
//
// Adding a new builtin: append to this slice. Removing one: leave it here
// (deletion is intentional and rare; if you really mean it, do it with a
// migration).
var builtinPlugins = []Plugin{
	{
		Name:                    "hami",
		DisplayName:             "HAMi",
		Description:             "GPU virtualization & vGPU scheduling for Kubernetes.",
		Category:                PluginCategoryGPU,
		IsBuiltin:               true,
		IconURL:                 "",
		ChartType:               ChartTypeRepo,
		ChartRepo:               "https://project-hami.github.io/HAMi/",
		ChartName:               "hami",
		DefaultVersion:          "",
		DefaultValues:           "",
		DefaultReleaseNamespace: "kube-system",
	},
	{
		Name:                    "victoria-metrics",
		DisplayName:             "VictoriaMetrics",
		Description:             "Cluster metrics & monitoring.",
		Category:                PluginCategoryMonitoring,
		IsBuiltin:               true,
		ChartType:               ChartTypeRepo,
		ChartRepo:               "https://victoriametrics.github.io/helm-charts/",
		ChartName:               "victoria-metrics-k8s-stack",
		DefaultReleaseNamespace: "monitoring",
	},
	{
		Name:                    "victoria-logs",
		DisplayName:             "VictoriaLogs",
		Description:             "Container logs collection & storage.",
		Category:                PluginCategoryLogging,
		IsBuiltin:               true,
		ChartType:               ChartTypeRepo,
		ChartRepo:               "https://victoriametrics.github.io/helm-charts/",
		ChartName:               "victoria-logs-single",
		DefaultReleaseNamespace: "logging",
	},
}

// SeedBuiltinPlugins upserts the builtin entries on startup. Built-ins are
// keyed by `name` (DNS-compatible, also doubles as the CRD metadata.name);
// existing rows are updated to match the latest hard-coded definition so
// fixes ship with the next deploy.
func SeedBuiltinPlugins(db *gorm.DB) error {
	for _, want := range builtinPlugins {
		var existing Plugin
		err := db.Where("name = ?", want.Name).First(&existing).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			if err := db.Create(&want).Error; err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			// Refresh fields that come from the binary (chart metadata,
			// description, default values) — never touch user-controlled
			// state, but built-ins don't really have any.
			updates := map[string]any{
				"display_name":              want.DisplayName,
				"description":               want.Description,
				"category":                  want.Category,
				"is_builtin":                true,
				"icon_url":                  want.IconURL,
				"chart_type":                want.ChartType,
				"chart_repo":                want.ChartRepo,
				"chart_name":                want.ChartName,
				"default_version":           want.DefaultVersion,
				"default_values":            want.DefaultValues,
				"default_release_namespace": want.DefaultReleaseNamespace,
			}
			if err := db.Model(&existing).Updates(updates).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
