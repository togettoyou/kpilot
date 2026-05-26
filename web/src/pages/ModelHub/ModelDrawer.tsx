import type { ProFormInstance } from '@ant-design/pro-components';
import {
  DrawerForm,
  ProFormDependency,
  ProFormDigit,
  ProFormRadio,
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
  ModelSource,
} from '@/services/kpilot/model';
import {
  createModel,
  FAMILY_LABELS,
  MODEL_FAMILIES,
  MODEL_RUNTIMES,
  MODEL_SOURCES,
  RUNTIME_DEFAULTS,
  RUNTIME_LABELS,
  SOURCE_LABELS,
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
  source: ModelSource;
  // Per-source identifier — only one of these is meaningful based on
  // `source` but we always carry all four in state so toggling the
  // Segmented control preserves whatever the user already typed in
  // an inactive field. Wire payload normalises to empty strings for
  // the unused ones.
  source_ref?: string;
  hf_endpoint?: string;
  oci_url?: string;
  local_path?: string;
  // Multi-line "one flag per line" text in the UI; serialised back
  // to the JSON array string wire format on submit. Same shape the
  // deploy drawer uses for extra_args, so users see a consistent
  // input style across both drawers.
  default_args_text?: string;
  // recommended_gpu broken out into three structured fields in the
  // UI; serialised back to a JSON blob on submit. The wire-level
  // `recommended_gpu` string stays unchanged so the server / cards
  // / detail drawer can keep parsing the same shape.
  gpu_count?: number;
  gpu_memory_gib?: number;
  gpu_model?: string;
  license?: string;
}

// argsJsonToText / argsTextToJson bridge the wire format (JSON
// string array, server's source of truth) and the UI format
// (newline-separated plain text, friendlier than authoring JSON).
// Symmetric — round-trip preserves order; bad JSON yields empty
// text rather than throwing so existing rows with broken data
// don't bomb the form.
const argsJsonToText = (json: string | undefined): string => {
  if (!json) return '';
  try {
    const arr = JSON.parse(json) as unknown[];
    if (!Array.isArray(arr)) return '';
    return arr.map((v) => String(v)).join('\n');
  } catch {
    return '';
  }
};

const argsTextToJson = (text: string | undefined): string => {
  if (!text) return '';
  const args = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return args.length > 0 ? JSON.stringify(args) : '';
};

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

    // Normalise the per-source fields: only the one matching the
    // selected source is sent with content; the others are blanked
    // so the server doesn't store stale values from a previous edit
    // where the user toggled source back and forth.
    const src = values.source;
    const payload: ModelPayload = {
      name: values.name,
      display_name: values.display_name,
      description: values.description ?? '',
      family: values.family,
      runtime: values.runtime,
      image: values.image,
      source: src,
      source_ref:
        src === 'huggingface' || src === 'modelscope'
          ? (values.source_ref ?? '')
          : '',
      hf_endpoint: src === 'huggingface' ? (values.hf_endpoint ?? '') : '',
      oci_url: src === 'oci' ? (values.oci_url ?? '') : '',
      local_path: src === 'local_path' ? (values.local_path ?? '') : '',
      default_args: argsTextToJson(values.default_args_text),
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
        description: isDuplicate ? '' : model.description,
        family: isDuplicate && model.is_builtin ? 'custom' : model.family,
        runtime: model.runtime,
        image: model.image,
        // Default legacy rows with empty `source` to huggingface —
        // matches the server-side default.
        source: model.source || 'huggingface',
        source_ref: model.source_ref,
        hf_endpoint: model.hf_endpoint,
        oci_url: model.oci_url,
        local_path: model.local_path,
        default_args_text: argsJsonToText(model.default_args),
        ...parseGPU(model.recommended_gpu),
        license: model.license,
      }
    : {
        family: 'custom',
        runtime: 'vllm',
        source: 'huggingface',
        // image + default_args pulled from the same RUNTIME_DEFAULTS
        // map the runtime auto-swap reads, so the initial open and a
        // subsequent runtime change land on identical templates.
        image: RUNTIME_DEFAULTS.vllm.image,
        default_args_text: argsJsonToText(RUNTIME_DEFAULTS.vllm.defaultArgs),
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
        // Runtime swap rewrites image + default_args to the new
        // runtime's template. Currently only vllm is supported, but
        // the swap path is kept so adding a future runtime only
        // needs an entry in RUNTIME_DEFAULTS.
        if (!('runtime' in changed) || !changed.runtime) return;
        const defaults = RUNTIME_DEFAULTS[changed.runtime as ModelRuntime];
        if (!defaults) return;
        formRef.current?.setFieldsValue({
          image: defaults.image,
          default_args_text: argsJsonToText(defaults.defaultArgs),
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
            pattern: /^[a-z]([-a-z0-9]*[a-z0-9])?$/,
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

      <Typography.Title level={5} style={{ marginBottom: 12, marginTop: 12 }}>
        {intl.formatMessage({ id: 'pages.common.source' })}
      </Typography.Title>

      {/* Source picker — button-style radio reads cleaner than a
          Select for a 4-way categorical with brand-name labels.
          The dependent fields render conditionally so an operator
          only sees the one that matters for their chosen source. */}
      <ProFormRadio.Group
        name="source"
        label={intl.formatMessage({ id: 'pages.models.registry.form.source' })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.source.help',
        })}
        radioType="button"
        options={MODEL_SOURCES.map((s) => ({
          label: SOURCE_LABELS[s],
          value: s,
        }))}
        rules={[{ required: true }]}
      />

      <ProFormDependency name={['source']}>
        {(values) => {
          // ProFormDependency types children as RenderChildren<unknown>;
          // narrow here rather than annotate the param so the inner
          // render function still type-checks against the parent's
          // generic.
          const source = (values?.source ?? 'huggingface') as ModelSource;
          // huggingface / modelscope share the same SourceRef shape
          // (a "org/repo" identifier on the hub). Label / tooltip /
          // placeholder vary by hub so the user sees the right
          // example string without guessing. HF also gets the
          // optional mirror endpoint field.
          if (source === 'huggingface') {
            return (
              <>
                <ProFormText
                  name="source_ref"
                  label={intl.formatMessage({
                    id: 'pages.models.registry.form.source_ref.hf',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.registry.form.source_ref.hf.help',
                  })}
                  placeholder="Qwen/Qwen3-0.6B"
                  rules={[{ required: true }, { max: 255 }]}
                  fieldProps={{ maxLength: 255 }}
                />
                <ProFormText
                  name="hf_endpoint"
                  label={intl.formatMessage({
                    id: 'pages.models.registry.form.hf_endpoint',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.registry.form.hf_endpoint.help',
                  })}
                  placeholder="https://hf-mirror.com"
                  rules={[{ max: 512 }]}
                  fieldProps={{ maxLength: 512 }}
                />
              </>
            );
          }
          if (source === 'modelscope') {
            return (
              <ProFormText
                name="source_ref"
                label={intl.formatMessage({
                  id: 'pages.models.registry.form.source_ref.ms',
                })}
                tooltip={intl.formatMessage({
                  id: 'pages.models.registry.form.source_ref.ms.help',
                })}
                placeholder="Qwen/Qwen3-0.6B"
                rules={[{ required: true }, { max: 255 }]}
                fieldProps={{ maxLength: 255 }}
              />
            );
          }
          if (source === 'local_path') {
            return (
              <ProFormText
                name="local_path"
                label={intl.formatMessage({
                  id: 'pages.models.registry.form.local_path',
                })}
                tooltip={intl.formatMessage({
                  id: 'pages.models.registry.form.local_path.help',
                })}
                placeholder="/models/qwen3-0.6b"
                rules={[
                  { required: true },
                  { max: 512 },
                  {
                    // Mirrors the server-side localPathRe; UI
                    // surfaces the constraint before submit so the
                    // operator doesn't see a generic 400.
                    pattern: /^\/[A-Za-z0-9._/-]+$/,
                    message: intl.formatMessage({
                      id: 'pages.models.registry.form.local_path.help',
                    }),
                  },
                ]}
                fieldProps={{ maxLength: 512 }}
              />
            );
          }
          // OCI
          return (
            <ProFormText
              name="oci_url"
              label={intl.formatMessage({
                id: 'pages.models.registry.form.oci_url',
              })}
              tooltip={intl.formatMessage({
                id: 'pages.models.registry.form.oci_url.help',
              })}
              placeholder="ghcr.io/myorg/qwen3-0.6b:v1"
              rules={[{ required: true }, { max: 512 }]}
              fieldProps={{ maxLength: 512 }}
            />
          );
        }}
      </ProFormDependency>

      <Typography.Title level={5} style={{ marginBottom: 12, marginTop: 12 }}>
        {intl.formatMessage({ id: 'pages.common.tuning' })}
      </Typography.Title>

      <ProFormTextArea
        name="default_args_text"
        label={intl.formatMessage({
          id: 'pages.models.registry.form.defaultArgs',
        })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.defaultArgs.help',
        })}
        placeholder={'--max-model-len\n32768\n--dtype\nauto'}
        fieldProps={{
          rows: 6,
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
