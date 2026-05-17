{{/*
Common helpers for the KPilot chart.

Naming convention:
  fullname        — release-scoped base name (used for global Secret /
                    ConfigMap when both server and worker are deployed)
  serverFullname  — server resources (Deployment, Service, etc.)
  workerFullname  — worker resources
  labels.*        — standard recommended labels split into selectorLabels
                    (immutable, embedded in selectors) and the full set
                    (rolling deploy will rewrite anything not in the
                    selector).
*/}}

{{- define "kpilot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kpilot.serverFullname" -}}
{{- printf "%s-server" (include "kpilot.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kpilot.workerFullname" -}}
{{- printf "%s-worker" (include "kpilot.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
postgresqlFullname is intentionally `<release>-postgresql` (NOT the
chart-fullname-prefixed form) so it stays byte-for-byte identical to
the Bitnami subchart's old Service name. Upgrades from Bitnami-backed
installs continue to dial the same Service, and the DSN helper below
doesn't need release-time conditionals.
*/}}
{{- define "kpilot.postgresqlFullname" -}}
{{- printf "%s-postgresql" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kpilot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kpilot.labels" -}}
helm.sh/chart: {{ include "kpilot.chart" . }}
{{ include "kpilot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kpilot.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kpilot.server.labels" -}}
{{ include "kpilot.labels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "kpilot.server.selectorLabels" -}}
{{ include "kpilot.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "kpilot.worker.labels" -}}
{{ include "kpilot.labels" . }}
app.kubernetes.io/component: worker
{{- end -}}

{{- define "kpilot.worker.selectorLabels" -}}
{{ include "kpilot.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end -}}

{{- define "kpilot.postgresql.labels" -}}
{{ include "kpilot.labels" . }}
app.kubernetes.io/component: postgresql
{{- end -}}

{{- define "kpilot.postgresql.selectorLabels" -}}
{{ include "kpilot.selectorLabels" . }}
app.kubernetes.io/component: postgresql
{{- end -}}

{{/*
Image reference helpers — resolve component-specific overrides on top
of the global image.* defaults. Tag falls back to .Chart.AppVersion if
neither component nor global tag is set, so a chart upgrade pulls a
matching image without an extra --set image.tag.
*/}}

{{- define "kpilot.server.image" -}}
{{- $reg := .Values.image.registry -}}
{{- $repo := default .Values.image.repository .Values.server.image.repository -}}
{{- $tag := default (default .Chart.AppVersion .Values.image.tag) .Values.server.image.tag -}}
{{- printf "%s/%s:%s" $reg $repo $tag -}}
{{- end -}}

{{- define "kpilot.worker.image" -}}
{{- $reg := .Values.image.registry -}}
{{- $repo := default .Values.image.repository .Values.worker.image.repository -}}
{{- $tag := default (default .Chart.AppVersion .Values.image.tag) .Values.worker.image.tag -}}
{{- printf "%s/%s:%s" $reg $repo $tag -}}
{{- end -}}

{{/*
Resolved DSN for the Server. Builds an in-cluster URL when the
bundled PostgreSQL StatefulSet is enabled (host = kpilot.postgresqlFullname),
otherwise honors the user-provided externalDsn. Fails fast at
template time if neither is set, which catches the most common
misconfiguration.
*/}}
{{- define "kpilot.server.dsn" -}}
{{- if .Values.postgresql.enabled -}}
{{- $u := .Values.postgresql.auth.username -}}
{{- $p := .Values.postgresql.auth.password -}}
{{- $db := .Values.postgresql.auth.database -}}
{{- $host := include "kpilot.postgresqlFullname" . -}}
{{- printf "postgres://%s:%s@%s:5432/%s?sslmode=disable" $u $p $host $db -}}
{{- else if .Values.server.postgresql.externalDsn -}}
{{- .Values.server.postgresql.externalDsn -}}
{{- else -}}
{{- fail "postgresql.enabled is false and server.postgresql.externalDsn is empty — set one of them" -}}
{{- end -}}
{{- end -}}

{{/*
JWT secret — uses the value from values.yaml when set, otherwise a
random per-install string. The string is cached in a Secret object so
chart upgrades don't rotate it (which would invalidate every active
session). lookup() reads the existing Secret if there is one.
*/}}
{{- define "kpilot.server.jwtSecret" -}}
{{- if .Values.server.jwtSecret -}}
{{- .Values.server.jwtSecret -}}
{{- else -}}
{{- $name := printf "%s-credentials" (include "kpilot.serverFullname" .) -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $name -}}
{{- if and $existing $existing.data.jwtSecret -}}
{{- index $existing.data "jwtSecret" | b64dec -}}
{{- else -}}
{{- randAlphaNum 64 -}}
{{- end -}}
{{- end -}}
{{- end -}}
