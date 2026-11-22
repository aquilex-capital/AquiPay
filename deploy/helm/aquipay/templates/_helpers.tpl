{{- define "aquipay.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "aquipay.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "aquipay.labels" -}}
app.kubernetes.io/name: aquipay
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "aquipay.selectorLabels" -}}
app.kubernetes.io/name: aquipay
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Non-secret settings shared by every role. `chains` overrides the chain list. */}}
{{- define "aquipay.env" -}}
- name: CHAINS
  value: {{ .chains | default (join "," .root.Values.config.chains) | quote }}
- name: FORWARDER_FACTORY_ADDRESS
  value: {{ required "config.forwarderFactoryAddress is required" .root.Values.config.forwarderFactoryAddress | quote }}
- name: PUBLIC_BASE_URL
  value: {{ .root.Values.config.publicBaseUrl | quote }}
- name: WEBHOOK_URL
  value: {{ .root.Values.config.webhookUrl | quote }}
{{- range $name, $value := .root.Values.config.extraEnv }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "aquipay.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  runAsUser: 1000
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{- define "aquipay.podScheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
