import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  InboxOutlined,
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
import { applyYAML } from '@/services/kpilot/workload';
import { YamlEditor } from './YamlEditor';

interface ApplyYamlDrawerProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
  clusterId: string;
  resourceType: WorkloadResourceType;
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
const TEMPLATES: Record<WorkloadResourceType, string> = {
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
        prometheus.io/path: /metrics
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
        prometheus.io/path: /metrics
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
        prometheus.io/path: /metrics
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
    prometheus.io/path: /metrics
spec:
  containers:
    - name: app
      image: fortio/fortio:latest
      ports:
        - containerPort: 8080
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
  const { message } = App.useApp();
  const { token } = antdTheme.useToken();

  const [yamlText, setYamlText] = useState('');
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ApplyYamlResult[] | null>(null);

  // Seed each time the drawer opens with a template matching the current
  // page's resource type — gives a relevant starting point if the user is
  // creating something from scratch. They can clear/replace freely; apply
  // itself is type-agnostic (Deployments page can apply a Service, etc.).
  useEffect(() => {
    if (open) {
      setYamlText(TEMPLATES[resourceType] ?? '');
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
        onApplied(); // refresh table for any successes
      }
    } catch {
      // Global error handler in requestErrorConfig already shows the toast.
    } finally {
      setApplying(false);
    }
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
          <Button type="primary" loading={applying} onClick={handleSubmit}>
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
      {results && results.some((r) => !r.success) && (
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
          description={
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
          }
        />
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        <YamlEditor value={yamlText} onChange={(v) => setYamlText(v)} />
      </div>
    </Drawer>
  );
}
