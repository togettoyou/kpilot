import { useIntl } from '@umijs/max';
import { App, InputNumber, Modal, Space, Tag } from 'antd';
import React, { useEffect, useState } from 'react';

import {
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
  currentReplicas: number;
  onScaled?: () => void;
}

// ScaleModal — simple "replicas N → M" knob. Server caps at [0, 1000]
// anyway, we mirror the upper bound on the InputNumber so the user
// can't paste a billion without immediate feedback. Lower bound 0
// supports "scale to zero" for off-hours cost cutting.
export function ScaleModal({
  open,
  onClose,
  clusterId,
  resourceType,
  name,
  namespace,
  currentReplicas,
  onScaled,
}: Props) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [value, setValue] = useState<number | null>(currentReplicas);
  const [submitting, setSubmitting] = useState(false);

  // Reset the input each time the modal opens so re-opening on a
  // different row doesn't show the previous target's number.
  useEffect(() => {
    if (open) setValue(currentReplicas);
  }, [open, currentReplicas]);

  const handleOk = async () => {
    if (value === null || value === undefined) return;
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
      maskClosable={false}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.65)' }}>
          {intl.formatMessage(
            { id: 'pages.scale.current' },
            { n: currentReplicas },
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
    </Modal>
  );
}

export default ScaleModal;
