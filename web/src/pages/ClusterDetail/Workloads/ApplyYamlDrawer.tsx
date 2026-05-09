import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  DownOutlined,
  InboxOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import type { UploadProps } from 'antd';
import {
  Alert,
  App,
  theme as antdTheme,
  Button,
  Drawer,
  List,
  Space,
  Tag,
  Upload,
} from 'antd';
import React, { useEffect, useState } from 'react';

import type {
  ApplyYamlResult,
  WorkloadResourceType,
} from '@/services/kpilot/workload';
import { applyYAML, deleteYAML } from '@/services/kpilot/workload';
import { YamlEditor } from './YamlEditor';

interface ApplyYamlDrawerProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
  clusterId: string;
  // '_cr' (CR-instances viewer) has no associated template — there are
  // arbitrarily many user-installed CRDs, no useful starter we could
  // pre-fill. The TEMPLATES lookup naturally returns undefined for it
  // and the editor opens empty, which is the right call (better than
  // confusing the user with a ConfigMap template on the Plugin page).
  resourceType: WorkloadResourceType | '_cr';
}

// Per-resource starting templates so the editor seeds with something
// relevant to the current page (Deployments page → Deployment skeleton).
// These are deliberately minimal so the user has less to delete; cleared/
// replaced freely. The apply itself is type-agnostic — even on the Pods
// page the user can paste a Service and it'll work.
//
// All workload templates use fortio/fortio:latest — a ~7 MB single
// Go binary whose default CMD is `server`, listens on :8080 and
// exposes /metrics out of the box (Go runtime + a few fortio_*
// gauges). Combined with the built-in VictoriaMetrics plugin and
// the pod's prometheus.io scrape annotations, applying any of these
// templates produces metrics in the VM UI within 15 s. Image is on
// Docker Hub, the most reliably reachable registry from CN networks.
// Partial — types that don't ship a starter template (e.g. `nodes`,
// which is blocked from Apply YAML server-side anyway) are intentionally
// missing. Lookups for those return undefined and the editor opens
// empty, same as the CR-instances form.
const TEMPLATES: Partial<Record<WorkloadResourceType, string>> = {
  deployments: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: /debug/metrics
    spec:
      containers:
        - name: app
          image: fortio/fortio:latest
          ports:
            - containerPort: 8080
`,
  statefulsets: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: example
  namespace: default
spec:
  serviceName: example
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: /debug/metrics
    spec:
      containers:
        - name: app
          image: fortio/fortio:latest
          ports:
            - containerPort: 8080
`,
  daemonsets: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: example
  namespace: default
spec:
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: /debug/metrics
    spec:
      containers:
        - name: app
          image: fortio/fortio:latest
          ports:
            - containerPort: 8080
`,
  pods: `apiVersion: v1
kind: Pod
metadata:
  name: example
  namespace: default
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
    prometheus.io/path: /debug/metrics
spec:
  containers:
    - name: app
      image: fortio/fortio:latest
      ports:
        - containerPort: 8080
`,
  // restartPolicy=OnFailure so a busy pod gets retried; the Job
  // controller terminates it once `completions` succeed (default 1).
  jobs: `apiVersion: batch/v1
kind: Job
metadata:
  name: example
  namespace: default
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: app
          image: busybox:1.37
          command: ["sh", "-c", "echo hello && sleep 5"]
`,
  // Cron expression "*/5 * * * *" → every 5 minutes; concurrencyPolicy
  // Forbid keeps overlapping runs from piling up if a job overruns.
  cronjobs: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: example
  namespace: default
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: app
              image: busybox:1.37
              command: ["sh", "-c", "date && echo tick"]
`,
  // Targets a Deployment named "example"; scales 1–5 replicas to keep
  // average CPU near 50%. Replace scaleTargetRef.name with the actual
  // workload, and adjust the metric/threshold to taste.
  horizontalpodautoscalers: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
`,
  services: `apiVersion: v1
kind: Service
metadata:
  name: example
  namespace: default
spec:
  selector:
    app: example
  ports:
    - port: 8080
      targetPort: 8080
`,
  ingresses: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: default
spec:
  rules:
    - host: example.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example
                port:
                  number: 80
`,
  // Gateway API templates assume the Envoy Gateway plugin is installed
  // (controllerName: gateway.envoyproxy.io/gatewayclass-controller).
  // Swap that string if a different Gateway API implementation is in use.
  gatewayclasses: `apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: example-gc
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
`,
  gateways: `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: example-gateway
  namespace: default
spec:
  gatewayClassName: example-gc
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Same
`,
  httproutes: `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: example-route
  namespace: default
spec:
  parentRefs:
    - name: example-gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: example
          port: 8080
`,
  grpcroutes: `apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: example-grpc-route
  namespace: default
spec:
  parentRefs:
    - name: example-gateway
  rules:
    - matches:
        - method:
            service: example.Greeter
      backendRefs:
        - name: example-grpc
          port: 9000
`,
  configmaps: `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  key: value
`,
  secrets: `apiVersion: v1
kind: Secret
metadata:
  name: example
  namespace: default
type: Opaque
stringData:
  key: value
`,
  persistentvolumeclaims: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`,
  persistentvolumes: `apiVersion: v1
kind: PersistentVolume
metadata:
  name: example
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /tmp/example
`,
  // hostpath provisioner ships with k3s/minikube; swap `provisioner`
  // for the cluster's actual CSI driver in production. WaitForFirstConsumer
  // is the safer default — Pod scheduling drives volume placement so
  // the PV lands on the right node when topology constraints exist.
  storageclasses: `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: example
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
`,
  // DRA — v1beta1 is served on K8s 1.32+; v1 only stable in 1.34. Driver
  // name and DeviceClass are placeholders — real values come from the
  // DRA driver running on the node (e.g. `gpu.nvidia.com`).
  resourceclaims: `apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: example
  namespace: default
spec:
  devices:
    requests:
      - name: gpu
        deviceClassName: gpu.example.com
`,
  resourceclaimtemplates: `apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: example
  namespace: default
spec:
  spec:
    devices:
      requests:
        - name: gpu
          deviceClassName: gpu.example.com
`,
  deviceclasses: `apiVersion: resource.k8s.io/v1
kind: DeviceClass
metadata:
  name: example.gpu.example.com
spec:
  selectors:
    - cel:
        expression: device.driver == "gpu.example.com"
`,
  // ResourceSlices are normally published by a DRA driver DaemonSet —
  // manual creation is rare, mostly useful for debugging the scheduler.
  resourceslices: `apiVersion: resource.k8s.io/v1
kind: ResourceSlice
metadata:
  name: node-0-gpu
spec:
  driver: gpu.example.com
  pool:
    name: node-0
    generation: 1
    resourceSliceCount: 1
  nodeName: node-0
  devices:
    - name: gpu-0
      basic:
        attributes:
          model:
            string: h100
`,
  // CRDs are typically distributed by the project that owns them
  // (helm chart `crds/` folder, operator install scripts). This is
  // a minimal valid skeleton mostly useful as a "show me the shape"
  // reference; real CRD specs are usually 100s of lines.
  customresourcedefinitions: `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: examples.example.io
spec:
  group: example.io
  names:
    plural: examples
    singular: example
    kind: Example
    shortNames: [ex]
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                message:
                  type: string
`,
  // ReplicaSets are normally managed by Deployments — manual
  // creation is rare. Skeleton useful for testing pod templates in
  // isolation without the rolling-update behavior of a Deployment.
  replicasets: `apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: example
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: fortio/fortio:latest
`,
  // EndpointSlice — almost always controller-generated by the
  // Service controller. Manual creation is occasionally useful for
  // headless / external Services.
  endpointslices: `apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: example-1
  namespace: default
  labels:
    kubernetes.io/service-name: example
addressType: IPv4
ports:
  - name: http
    protocol: TCP
    port: 80
endpoints:
  - addresses:
      - 10.0.0.1
    conditions:
      ready: true
`,
  // NetworkPolicy — default-deny-ingress for a namespace is the
  // most common starter; refine selectors / allow rules from there.
  networkpolicies: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: default
spec:
  podSelector: {}
  policyTypes:
    - Ingress
`,
  // ServiceAccount — referenced by Pod spec.serviceAccountName.
  serviceaccounts: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: example
  namespace: default
`,
  // Role — read-only access to common resources in a namespace.
  roles: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: example-reader
  namespace: default
rules:
  - apiGroups: [""]
    resources: [pods, services, configmaps]
    verbs: [get, list, watch]
`,
  // RoleBinding — binds the Role above to a ServiceAccount.
  rolebindings: `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: example-reader
  namespace: default
subjects:
  - kind: ServiceAccount
    name: example
    namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: example-reader
`,
  // ClusterRole — fleet-wide read access. Avoid the system: prefix
  // (KPilot blocks edits / deletes on system:* names).
  clusterroles: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: example-cluster-reader
rules:
  - apiGroups: [""]
    resources: [namespaces, nodes, pods]
    verbs: [get, list, watch]
`,
  clusterrolebindings: `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: example-cluster-reader
subjects:
  - kind: ServiceAccount
    name: example
    namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: example-cluster-reader
`,
  // ResourceQuota — caps per-namespace consumption. Common starter
  // is CPU + memory + pod count. Add nvidia.com/gpu for GPU
  // namespaces once HAMi is enabled.
  resourcequotas: `apiVersion: v1
kind: ResourceQuota
metadata:
  name: example
  namespace: default
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
`,
  // LimitRange — defaults applied to containers that don't set
  // their own requests / limits. Covers the "noisy neighbor" case.
  limitranges: `apiVersion: v1
kind: LimitRange
metadata:
  name: example-defaults
  namespace: default
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
`,
  // PodDisruptionBudget — minAvailable=1 keeps at least one pod
  // running through voluntary disruptions (drain / upgrade).
  poddisruptionbudgets: `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example
  namespace: default
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: example
`,
  // PriorityClass — cluster-scoped. KPilot rejects edits / deletes
  // for names beginning with system- (control-plane critical), so
  // pick a non-system name like below.
  priorityclasses: `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: example-high-priority
value: 1000
globalDefault: false
description: "High-priority workloads (training jobs, etc.)"
`,
  // RuntimeClass — switches the container runtime for a Pod. Common
  // uses: gVisor (runsc) for isolation, Kata for VM-grade boundary,
  // nvidia for GPU passthrough on certain NVIDIA stacks.
  runtimeclasses: `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: example-runtime
handler: runc
`,
  // ValidatingWebhookConfiguration — operator-installed normally;
  // hand-crafting is rare. Skeleton shows the expected fields so
  // you can read existing configs more easily.
  validatingwebhookconfigurations: `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: example-validate
webhooks:
  - name: example.validate.example.io
    clientConfig:
      service:
        name: example-webhook
        namespace: default
        path: /validate
      caBundle: ""  # base64 PEM of the cluster's CA
    rules:
      - apiGroups: [""]
        apiVersions: [v1]
        operations: [CREATE, UPDATE]
        resources: [pods]
    admissionReviewVersions: [v1]
    sideEffects: None
    failurePolicy: Fail
    timeoutSeconds: 5
`,
  mutatingwebhookconfigurations: `apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: example-mutate
webhooks:
  - name: example.mutate.example.io
    clientConfig:
      service:
        name: example-webhook
        namespace: default
        path: /mutate
      caBundle: ""
    rules:
      - apiGroups: [""]
        apiVersions: [v1]
        operations: [CREATE]
        resources: [pods]
    admissionReviewVersions: [v1]
    sideEffects: None
    reinvocationPolicy: Never  # or IfNeeded
    failurePolicy: Ignore
    timeoutSeconds: 5
`,
  // ValidatingAdmissionPolicy — GA since K8s 1.30. CEL-based
  // policy engine; doesn't need a webhook server. Pair with a
  // ValidatingAdmissionPolicyBinding (separate resource) to scope.
  validatingadmissionpolicies: `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: example-policy
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: "object.spec.replicas <= 5"
      message: "replicas must be <= 5"
`,
  // MutatingAdmissionPolicy — alpha since K8s 1.32 (feature gate
  // MutatingAdmissionPolicy=true). The mutating counterpart of
  // ValidatingAdmissionPolicy: CEL + ApplyConfiguration / JSON
  // patch instead of validation expressions. Pair with a
  // MutatingAdmissionPolicyBinding to scope.
  mutatingadmissionpolicies: `apiVersion: admissionregistration.k8s.io/v1alpha1
kind: MutatingAdmissionPolicy
metadata:
  name: example-mutator
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE"]
        resources: ["pods"]
  reinvocationPolicy: Never
  mutations:
    - patchType: ApplyConfiguration
      applyConfiguration:
        expression: |
          Object{
            metadata: Object.metadata{
              labels: {"injected-by": "example-mutator"}
            }
          }
`,
};

const MAX_FILE_BYTES = 1 << 20; // 1 MB — same cap as the server

export function ApplyYamlDrawer({
  open,
  onClose,
  onApplied,
  clusterId,
  resourceType,
}: ApplyYamlDrawerProps) {
  const intl = useIntl();
  const { message, modal } = App.useApp();
  const { token } = antdTheme.useToken();

  const [yamlText, setYamlText] = useState('');
  const [applying, setApplying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [results, setResults] = useState<ApplyYamlResult[] | null>(null);
  // Default to expanded — user just clicked Apply and wants to see the
  // diagnosis. Collapse is one click away when they need editor space
  // back. Resets to expanded on every new apply.
  const [resultsExpanded, setResultsExpanded] = useState(true);

  // Seed each time the drawer opens with a template matching the current
  // page's resource type — gives a relevant starting point if the user is
  // creating something from scratch. They can clear/replace freely; apply
  // itself is type-agnostic (Deployments page can apply a Service, etc.).
  useEffect(() => {
    if (open) {
      // TEMPLATES is keyed on WorkloadResourceType only; for the CR-
      // instances viewer ('_cr') we have no template (arbitrary
      // user-installed CRDs, no useful starter to pre-fill) and the
      // editor opens empty. Cast through unknown so the index lookup
      // type-checks without widening TEMPLATES.
      const tpl = (TEMPLATES as Record<string, string>)[resourceType];
      setYamlText(tpl ?? '');
      setResults(null);
    }
  }, [open, resourceType]);

  const handleSubmit = async () => {
    const trimmed = yamlText.trim();
    if (!trimmed) {
      message.warning(intl.formatMessage({ id: 'pages.applyYaml.empty' }));
      return;
    }
    setApplying(true);
    setResults(null);
    try {
      const resp = await applyYAML(clusterId, trimmed);
      const list = resp.results ?? [];
      const failed = list.filter((r) => !r.success);

      if (failed.length === 0) {
        // All docs applied — close drawer and refresh.
        message.success(
          intl.formatMessage(
            { id: 'pages.applyYaml.successN' },
            { n: list.length },
          ),
        );
        setYamlText('');
        onApplied();
        onClose();
      } else {
        // Partial / total failure — keep drawer open and surface per-doc
        // results so the user can fix and retry without losing their work.
        setResults(list);
        setResultsExpanded(true); // expanded by default on each new apply
        onApplied(); // refresh table for any successes
      }
    } catch {
      // Global error handler in requestErrorConfig already shows the toast.
    } finally {
      setApplying(false);
    }
  };

  // Delete is the inverse of Apply — sends the same YAML body to the
  // worker's `delete` action per doc. Wrapped in a danger-styled
  // modal.confirm so the user has an explicit pause before the
  // destructive batch operation. Same per-doc result rendering as Apply
  // so partial failures (some deleted, some 404 / locked / etc.) are
  // visible.
  const handleDelete = async () => {
    const trimmed = yamlText.trim();
    if (!trimmed) {
      message.warning(intl.formatMessage({ id: 'pages.applyYaml.empty' }));
      return;
    }
    modal.confirm({
      title: intl.formatMessage({ id: 'pages.applyYaml.delete.confirmTitle' }),
      content: intl.formatMessage({ id: 'pages.applyYaml.delete.confirmHint' }),
      okType: 'danger',
      okText: intl.formatMessage({ id: 'pages.applyYaml.delete.confirmOk' }),
      onOk: async () => {
        setDeleting(true);
        setResults(null);
        try {
          const resp = await deleteYAML(clusterId, trimmed);
          const list = resp.results ?? [];
          const failed = list.filter((r) => !r.success);
          if (failed.length === 0) {
            message.success(
              intl.formatMessage(
                { id: 'pages.applyYaml.delete.successN' },
                { n: list.length },
              ),
            );
            // Keep YAML in editor — user might want to re-apply the same
            // manifest later. Just close the drawer.
            onApplied();
            onClose();
          } else {
            setResults(list);
            setResultsExpanded(true);
            onApplied();
          }
        } catch {
          // Global toast.
        } finally {
          setDeleting(false);
        }
      },
    });
  };

  const uploadProps: UploadProps = {
    accept: '.yaml,.yml,.json',
    beforeUpload: (file) => {
      if (file.size > MAX_FILE_BYTES) {
        message.error(intl.formatMessage({ id: 'pages.applyYaml.tooLarge' }));
        return Upload.LIST_IGNORE;
      }
      const reader = new FileReader();
      reader.onload = (e) => setYamlText(String(e.target?.result ?? ''));
      reader.onerror = () =>
        message.error(intl.formatMessage({ id: 'pages.applyYaml.readError' }));
      reader.readAsText(file);
      return Upload.LIST_IGNORE; // we handle the read manually; don't upload
    },
    showUploadList: false,
    multiple: false,
  };

  return (
    <Drawer
      title={intl.formatMessage({ id: 'pages.applyYaml.title' })}
      open={open}
      onClose={onClose}
      size={680}
      maskClosable={false}
      destroyOnHidden
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>
            {intl.formatMessage({ id: 'pages.workloads.cancel' })}
          </Button>
          {/* Danger button gets a tooltip + confirm modal on click — both
              live in handleDelete. Disabled while an Apply is in flight
              so the two can't race for the same loading state. */}
          <Button
            danger
            loading={deleting}
            disabled={applying}
            onClick={handleDelete}
          >
            {intl.formatMessage({ id: 'pages.applyYaml.delete' })}
          </Button>
          <Button
            type="primary"
            loading={applying}
            disabled={deleting}
            onClick={handleSubmit}
          >
            {intl.formatMessage({ id: 'pages.applyYaml.apply' })}
          </Button>
        </Space>
      }
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <Upload.Dragger
        {...uploadProps}
        style={{
          margin: 16,
          marginBottom: 8,
          padding: '8px 0',
          border: `1px dashed ${token.colorBorderSecondary}`,
        }}
      >
        <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}>
          <InboxOutlined style={{ fontSize: 24 }} />
        </p>
        <p
          className="ant-upload-text"
          style={{ fontSize: 13, marginBottom: 0 }}
        >
          {intl.formatMessage({ id: 'pages.applyYaml.dropHint' })}
        </p>
      </Upload.Dragger>
      {results?.some((r) => !r.success) && (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '0 16px 8px' }}
          message={intl.formatMessage(
            { id: 'pages.applyYaml.partial' },
            {
              ok: results.filter((r) => r.success).length,
              total: results.length,
            },
          )}
          // Collapse toggle in the action slot — one click hides the
          // per-doc list so the user can scroll the YAML editor freely
          // while keeping the summary visible.
          action={
            <Button
              type="text"
              size="small"
              icon={resultsExpanded ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setResultsExpanded(!resultsExpanded)}
            >
              {intl.formatMessage({
                id: resultsExpanded
                  ? 'pages.applyYaml.collapse'
                  : 'pages.applyYaml.expand',
              })}
            </Button>
          }
          description={
            // Cap the result list — without this, applying many docs
            // where most fail would push the YAML editor below the
            // viewport with nothing scrollable to bring it back. 240px
            // ≈ 8 single-line items at compact List padding; for longer
            // lists the user scrolls within the alert's own scroll area.
            // When collapsed, omit the description entirely so the
            // alert shrinks to just its message + toggle.
            resultsExpanded ? (
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                <List
                  size="small"
                  dataSource={results}
                  split={false}
                  renderItem={(r) => (
                    <List.Item style={{ padding: '4px 0' }}>
                      <Space size="small" align="start">
                        {r.success ? (
                          <CheckCircleTwoTone twoToneColor="#52c41a" />
                        ) : (
                          <CloseCircleTwoTone twoToneColor="#ff4d4f" />
                        )}
                        <span>
                          {r.kind && <Tag>{r.kind}</Tag>}
                          <span style={{ fontFamily: 'monospace' }}>
                            {r.namespace ? `${r.namespace}/` : ''}
                            {r.name || `#${r.index}`}
                          </span>
                          {r.error && (
                            <span style={{ marginLeft: 8, color: '#ff4d4f' }}>
                              {r.error}
                            </span>
                          )}
                        </span>
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            ) : null
          }
        />
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        <YamlEditor value={yamlText} onChange={(v) => setYamlText(v)} />
      </div>
    </Drawer>
  );
}
