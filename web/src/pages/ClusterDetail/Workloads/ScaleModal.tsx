import { useIntl } from '@umijs/max';
import { App, InputNumber, Modal, Skeleton, Space, Tag } from 'antd';
import React, { useEffect, useState } from 'react';

import {
  getWorkload,
  scaleWorkload,
  type WorkloadResourceType,
} from '@/services/kpilot/workload';

interface Props {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  resourceType: WorkloadResourceType;
  name: string;
  namespace: string;
  onScaled?: () => void;
}

// ScaleModal — simple "replicas N → M" knob. Server caps at [0, 1000]
// anyway, we mirror the upper bound on the InputNumber so the user
// can't paste a billion without immediate feedback. Lower bound 0
// supports "scale to zero" for off-hours cost cutting.
//
// We fetch the live object on open instead of trusting a parent-
// supplied currentReplicas — the Workloads list goes through the
// Table API with includeObject=Metadata, which strips spec.replicas
// from the row payload (a Deployment row's "Replicas" column is
// rendered server-side as "3/3" text, not as a struct). Pulling
// the full object via getWorkload is the only way to get the
// authoritative `.spec.replicas` for the InputNumber initial value.
export function ScaleModal({
  open,
  onClose,
  clusterId,
  resourceType,
  name,
  namespace,
  onScaled,
}: Props) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [currentReplicas, setCurrentReplicas] = useState<number | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Fetch the live object on open. Reset state when the target
  // changes (re-opening on a different row).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setCurrentReplicas(null);
    setValue(null);
    getWorkload(clusterId, resourceType, name, namespace)
      .then((obj: any) => {
        if (cancelled) return;
        const r = obj?.spec?.replicas ?? 0;
        setCurrentReplicas(r);
        setValue(r);
      })
      .catch(() => {
        // Global toast already fired by the request layer; close so
        // the user can re-try after fixing connectivity.
        if (!cancelled) onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clusterId, resourceType, name, namespace, onClose]);

  const handleOk = async () => {
    if (value === null || value === undefined || currentReplicas === null) {
      return;
    }
    if (value === currentReplicas) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await scaleWorkload(clusterId, resourceType, name, namespace, value);
      message.success(
        intl.formatMessage(
          { id: 'pages.scale.success' },
          { from: currentReplicas, to: value },
        ),
      );
      onScaled?.();
      onClose();
    } catch {
      // global error handler shows the toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.scale.title' })}</span>
          <Tag>{namespace}</Tag>
          <Tag color="blue">{name}</Tag>
        </Space>
      }
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={submitting}
      okText={intl.formatMessage({ id: 'pages.scale.confirm' })}
      cancelText={intl.formatMessage({ id: 'pages.common.cancel' })}
      okButtonProps={{ disabled: loading || currentReplicas === null }}
      maskClosable={false}
      destroyOnHidden
    >
      {loading ? (
        <Skeleton active paragraph={{ rows: 1 }} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.65)' }}>
            {intl.formatMessage(
              { id: 'pages.scale.current' },
              { n: currentReplicas ?? 0 },
            )}
          </div>
          <InputNumber
            autoFocus
            min={0}
            max={1000}
            value={value}
            onChange={(v) => setValue(typeof v === 'number' ? v : null)}
            style={{ width: '100%' }}
            onPressEnter={handleOk}
          />
        </Space>
      )}
    </Modal>
  );
}

export default ScaleModal;
