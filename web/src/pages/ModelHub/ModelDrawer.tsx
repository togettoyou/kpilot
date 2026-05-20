import type { ProFormInstance } from '@ant-design/pro-components';
import {
  DrawerForm,
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
  recommended_gpu?: string;
  license?: string;
}

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
    if (values.recommended_gpu) {
      try {
        const obj = JSON.parse(values.recommended_gpu);
        if (typeof obj !== 'object' || Array.isArray(obj)) {
          throw new Error('not an object');
        }
      } catch {
        message.error(
          intl.formatMessage({
            id: 'pages.models.registry.form.recommendedGPU.help',
          }),
        );
        return false;
      }
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
      recommended_gpu: values.recommended_gpu ?? '',
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
        recommended_gpu: model.recommended_gpu,
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
        recommended_gpu: '{"count":1,"memoryGiB":24,"model":"any"}',
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

      <ProFormTextArea
        name="recommended_gpu"
        label={intl.formatMessage({
          id: 'pages.models.registry.form.recommendedGPU',
        })}
        tooltip={intl.formatMessage({
          id: 'pages.models.registry.form.recommendedGPU.help',
        })}
        fieldProps={{
          rows: 3,
          maxLength: 1024,
          showCount: true,
          style: { fontFamily: 'monospace', fontSize: 12 },
        }}
      />

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
