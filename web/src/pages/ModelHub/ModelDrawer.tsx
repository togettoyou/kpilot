import type { ProFormInstance } from '@ant-design/pro-components';
import {
  DrawerForm,
  ProFormDigit,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import { useIntl } from '@umijs/max';
import { App, Typography } from 'antd';
import React, { useRef } from 'react';

import type {
  Model,
  ModelFamily,
  ModelPayload,
  ModelRuntime,
} from '@/services/kpilot/model';
import {
  createModel,
  FAMILY_LABELS,
  MODEL_FAMILIES,
  MODEL_RUNTIMES,
  RUNTIME_DEFAULTS,
  RUNTIME_LABELS,
  updateModel,
} from '@/services/kpilot/model';

export type ModelDrawerMode = 'create' | 'edit' | 'duplicate';

interface Props {
  open: boolean;
  // For mode='edit' or 'duplicate', `model` is the source row. In
  // 'duplicate' we ignore the source's id/is_builtin and treat the
  // submit as a fresh Create (so even built-ins can be cloned into
  // a new custom row). In 'create' the source is null.
  model: Model | null;
  mode: ModelDrawerMode;
  onClose: () => void;
  onSaved: () => void;
}

interface FormValues {
  name: string;
  display_name: string;
  description?: string;
  family: ModelFamily;
  runtime: ModelRuntime;
  image: string;
  hugging_face_id?: string;
  default_args?: string;
  // recommended_gpu broken out into three structured fields in the
  // UI; serialised back to a JSON blob on submit. The wire-level
  // `recommended_gpu` string stays unchanged so the server / cards
  // / detail drawer can keep parsing the same shape.
  gpu_count?: number;
  gpu_memory_gib?: number;
  gpu_model?: string;
  license?: string;
}

// Known GPU model shorthands the seed presets use. "any" = no
// constraint, used when a 24 GB anything (T4 / RTX / A10) will do.
const GPU_MODEL_OPTIONS = ['any', 'T4', 'A10', 'A100', 'H100', 'B100'];

// ModelDrawer is the create + edit form. Built-in rows never open it
// (the table buttons are disabled), so we don't worry about the
// is_builtin lock here — server rejects PATCH anyway as a defense-
// in-depth check.
const ModelDrawer: React.FC<Props> = ({
  open,
  model,
  mode,
  onClose,
  onSaved,
}) => {
  const intl = useIntl();
  const { message } = App.useApp();

  // Edit ↔ Create distinction drives the API call + the name-field
  // disabled state. Duplicate behaves like Create on submit, but
  // pre-fills from `model`.
  const isEdit = mode === 'edit' && !!model;
  const isDuplicate = mode === 'duplicate' && !!model;
  // formKey rotates per source row + mode so opening duplicate from
  // row A right after closing edit on row B doesn't leak stale form
  // values. 'new' for plain create.
  const formKey = model ? `${mode}-${model.id}` : 'new';

  const handleFinish = async (values: FormValues) => {
    // JSON validation client-side too — server validates again but
    // surfacing the parse error here gives a clearer message than
    // "INVALID_REQUEST".
    if (values.default_args) {
      try {
        const arr = JSON.parse(values.default_args);
        if (!Array.isArray(arr) || arr.some((v) => typeof v !== 'string')) {
          throw new Error('not a string array');
        }
      } catch {
        message.error(
          intl.formatMessage({
            id: 'pages.models.registry.form.defaultArgs.help',
          }),
        );
        return false;
      }
    }
    // Compose the recommended_gpu wire blob from the three
    // structured form fields. Only emit fields the user actually
    // set so the server-side validator doesn't see {"count":0}
    // and reject it as malformed.
    const recommended_gpu: Record<string, unknown> = {};
    if (values.gpu_count && values.gpu_count > 0) {
      recommended_gpu.count = values.gpu_count;
    }
    if (values.gpu_memory_gib && values.gpu_memory_gib > 0) {
      recommended_gpu.memoryGiB = values.gpu_memory_gib;
    }
    if (values.gpu_model) {
      recommended_gpu.model = values.gpu_model;
    }

    const payload: ModelPayload = {
      name: values.name,
      display_name: values.display_name,
      description: values.description ?? '',
      family: values.family,
      runtime: values.runtime,
      image: values.image,
      hugging_face_id: values.hugging_face_id ?? '',
      default_args: values.default_args ?? '',
      recommended_gpu:
        Object.keys(recommended_gpu).length > 0
          ? JSON.stringify(recommended_gpu)
          : '',
      license: values.license ?? '',
    };

    if (isEdit && model) {
      await updateModel(model.id, payload);
    } else {
      await createModel(payload);
    }
    message.success(intl.formatMessage({ id: 'pages.common.saved' }));
    onSaved();
    return true;
  };

  // parseGPU pulls existing model.recommended_gpu (JSON blob) into
  // the three form fields. Falls back to undefined per-field on
  // bad JSON / missing key so the form shows the placeholder
  // instead of forcing an arbitrary number.
  const parseGPU = (raw: string | undefined) => {
    if (!raw)
      return {
        gpu_count: undefined,
        gpu_memory_gib: undefined,
        gpu_model: undefined,
      };
    try {
      const g = JSON.parse(raw) as {
        count?: number;
        memoryGiB?: number;
        model?: string;
      };
      return {
        gpu_count: g.count,
        gpu_memory_gib: g.memoryGiB,
        gpu_model: g.model,
      };
    } catch {
      return {
        gpu_count: undefined,
        gpu_memory_gib: undefined,
        gpu_model: undefined,
      };
    }
  };

  const initial: Partial<FormValues> = model
    ? {
        // In duplicate mode, suffix the name with "-copy" so the
        // unique-name check passes on submit. Also force family to
        // "custom" when cloning a built-in — the duplicate is a
        // user row whether the source was internal or not. The
        // name field stays editable in duplicate mode so the user
        // can pick something better.
        name: isDuplicate ? `${model.name}-copy` : model.name,
        display_name: isDuplicate
          ? `${model.display_name} (Copy)`
          : model.display_name,
        description: model.description,
        family: isDuplicate && model.is_builtin ? 'custom' : model.family,
        runtime: model.runtime,
        image: model.image,
        hugging_face_id: model.hugging_face_id,
        default_args: model.default_args,
        ...parseGPU(model.recommended_gpu),
        license: model.license,
      }
    : {
        family: 'custom',
        runtime: 'vllm',
        // image + default_args pulled from the same RUNTIME_DEFAULTS
        // map the runtime auto-swap reads, so the initial open and a
        // subsequent runtime change land on identical templates.
        image: RUNTIME_DEFAULTS.vllm.image,
        default_args: RUNTIME_DEFAULTS.vllm.defaultArgs,
        gpu_count: 1,
        gpu_memory_gib: 24,
        gpu_model: 'any',
      };

  // formRef lets onValuesChange reach back into the form to overwrite
  // image + default_args when runtime flips. The ref initialiser uses
  // undefined (not null) to satisfy ProForm's RefObject<T | undefined>
  // formRef prop signature; setFieldsValue inherits from antd's
  // FormInstance unchanged.
  const formRef = useRef<ProFormInstance<FormValues> | undefined>(undefined);

  return (
    <DrawerForm<FormValues>
      key={formKey}
      title={intl.formatMessage({
        id: isEdit
          ? 'pages.models.registry.edit'
          : isDuplicate
            ? 'pages.models.registry.duplicate'
            : 'pages.models.registry.new',
      })}
      formRef={formRef}
      open={open}
      onFinish={handleFinish}
      onOpenChange={(visible) => {
        if (!visible) onClose();
      }}
      onValuesChange={(changed) => {
        // Only auto-swap in NEW mode — editing an existing row should
        // never surprise-rewrite the image/args the user picked
        // before. Also gate on the runtime field specifically; other
        // form changes (name typed in, family picked) don't touch
        // image/args.
        if (isEdit) return;
        if (!('runtime' in changed) || !changed.runtime) return;
        const defaults = RUNTIME_DEFAULTS[changed.runtime as ModelRuntime];
        if (!defaults) return;
        formRef.current?.setFieldsValue({
          image: defaults.image,
          default_args: defaults.defaultArgs,
        });
      }}
      drawerProps={{
        size: 'large',
        maskClosable: false,
        destroyOnHidden: true,
      }}
      initialValues={initial}
      autoFocusFirstInput
    >
      <Typography.Title level={5} style={{ marginBottom: 12 }}>
        {intl.formatMessage({ id: 'pages.common.identity' })}
      </Typography.Title>

      <ProFormText
        name="name"
        label={intl.formatMessage({ id: 'pages.models.registry.form.name' })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.name.help',
        })}
        rules={[
          { required: true },
          {
            pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
            message: intl.formatMessage({
              id: 'pages.models.registry.form.name.help',
            }),
          },
          { max: 63 },
        ]}
        fieldProps={{ maxLength: 63, showCount: true }}
        disabled={isEdit}
      />

      <ProFormText
        name="display_name"
        label={intl.formatMessage({
          id: 'pages.models.registry.form.displayName',
        })}
        rules={[{ required: true }, { max: 255 }]}
        fieldProps={{ maxLength: 255 }}
      />

      <ProFormSelect
        name="family"
        label={intl.formatMessage({ id: 'pages.models.registry.form.family' })}
        options={MODEL_FAMILIES.map((f) => ({
          label:
            f === 'custom'
              ? intl.formatMessage({ id: 'pages.models.registry.custom' })
              : FAMILY_LABELS[f],
          value: f,
        }))}
        rules={[{ required: true }]}
      />

      <ProFormTextArea
        name="description"
        label={intl.formatMessage({
          id: 'pages.models.registry.form.description',
        })}
        rules={[{ max: 500 }]}
        fieldProps={{ rows: 2, maxLength: 500, showCount: true }}
      />

      <Typography.Title level={5} style={{ marginBottom: 12, marginTop: 12 }}>
        {intl.formatMessage({ id: 'pages.common.runtime' })}
      </Typography.Title>

      <ProFormSelect
        name="runtime"
        label={intl.formatMessage({ id: 'pages.models.registry.form.runtime' })}
        options={MODEL_RUNTIMES.map((r) => ({
          label: RUNTIME_LABELS[r],
          value: r,
        }))}
        rules={[{ required: true }]}
      />

      <ProFormText
        name="image"
        label={intl.formatMessage({ id: 'pages.models.registry.form.image' })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.image.help',
        })}
        rules={[{ required: true }, { max: 512 }]}
        fieldProps={{ maxLength: 512 }}
      />

      <ProFormText
        name="hugging_face_id"
        label={intl.formatMessage({ id: 'pages.models.registry.form.hf' })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.hf.help',
        })}
        rules={[{ max: 255 }]}
        fieldProps={{ maxLength: 255 }}
      />

      <Typography.Title level={5} style={{ marginBottom: 12, marginTop: 12 }}>
        {intl.formatMessage({ id: 'pages.common.tuning' })}
      </Typography.Title>

      <ProFormTextArea
        name="default_args"
        label={intl.formatMessage({
          id: 'pages.models.registry.form.defaultArgs',
        })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.defaultArgs.help',
        })}
        fieldProps={{
          rows: 4,
          maxLength: 8192,
          showCount: true,
          style: { fontFamily: 'monospace', fontSize: 12 },
        }}
      />

      {/* Recommended GPU shape — three structured fields composed
          into the recommended_gpu wire JSON on submit. Three
          inline ProForm controls in a row read better than a
          single JSON TextArea for picking sane numbers; the
          deploy drawer + card cells parse the same JSON blob
          shape regardless of how it was authored. */}
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {intl.formatMessage({
          id: 'pages.models.registry.form.recommendedGPU',
        })}
      </Typography.Text>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12,
          marginTop: 4,
        }}
      >
        <ProFormDigit
          name="gpu_count"
          label={intl.formatMessage({
            id: 'pages.models.registry.form.recommendedGPU.count',
          })}
          fieldProps={{ min: 1, max: 16, style: { width: '100%' } }}
        />
        <ProFormDigit
          name="gpu_memory_gib"
          label={intl.formatMessage({
            id: 'pages.models.registry.form.recommendedGPU.memory',
          })}
          fieldProps={{ min: 1, max: 2048, style: { width: '100%' } }}
        />
        <ProFormSelect
          name="gpu_model"
          label={intl.formatMessage({
            id: 'pages.models.registry.form.recommendedGPU.model',
          })}
          options={GPU_MODEL_OPTIONS.map((g) => ({ label: g, value: g }))}
          fieldProps={{ showSearch: true, allowClear: true }}
        />
      </div>

      <ProFormText
        name="license"
        label={intl.formatMessage({ id: 'pages.models.registry.form.license' })}
        placeholder={intl.formatMessage({
          id: 'pages.models.registry.form.license.placeholder',
        })}
        rules={[{ max: 64 }]}
        fieldProps={{ maxLength: 64 }}
      />
    </DrawerForm>
  );
};

export default ModelDrawer;
