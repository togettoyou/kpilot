{{/*
Common labels applied to every resource in this chart. Includes the
standard app.kubernetes.io/* recommended labels so cluster tools (and
KPilot's `app.kubernetes.io/managed-by=Helm` write-protection gate)
can identify chart-owned resources.
*/}}
{{- define "volcano-vgpu.labels" -}}
app.kubernetes.io/name: volcano-vgpu-device-plugin
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}
