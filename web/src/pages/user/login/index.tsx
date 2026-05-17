import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { LoginForm, ProFormText } from '@ant-design/pro-components';
import { Helmet, history, useIntl, useModel, useRequest } from '@umijs/max';
import { Alert, App, Form } from 'antd';
import { createStyles } from 'antd-style';
import React, { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Footer, LangDropdown } from '@/components';
import { authDefaults, login } from '@/services/kpilot/auth';

const useStyles = createStyles(({ token }) => ({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'auto',
    backgroundColor: token.colorBgLayout,
  },
}));

const getSafeRedirectUrl = (redirect: string | null): string => {
  if (!redirect?.startsWith('/') || redirect.startsWith('//')) return '/';
  try {
    const parsed = new URL(redirect, window.location.origin);
    if (parsed.origin !== window.location.origin) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
};

export default function LoginPage() {
  const [error, setError] = useState('');
  const { initialState, setInitialState } = useModel('@@initialState');
  const { styles } = useStyles();
  const { message } = App.useApp();
  const intl = useIntl();
  // Public endpoint — only returns credentials when the deployment is
  // still on the seed ADMIN_PASSWORD. Errors are swallowed (the hint is
  // a nice-to-have, not load-bearing); formatResult per CLAUDE.md.
  const { data: defaults } = useRequest(authDefaults, {
    formatResult: (res) => res,
    onError: () => undefined,
  });
  const [form] = Form.useForm<{ username?: string; password?: string }>();
  // Prefill the form when the server reports seed credentials. Guarded
  // on both fields being empty so a slow /defaults response can't clobber
  // what the user has already typed.
  useEffect(() => {
    if (!defaults?.usingDefaults || !defaults.username || !defaults.password) return;
    const current = form.getFieldsValue();
    if (!current.username && !current.password) {
      form.setFieldsValue({ username: defaults.username, password: defaults.password });
    }
  }, [defaults, form]);

  const handleSubmit = async (values: { username: string; password: string }) => {
    setError('');
    try {
      const result = await login(values);
      if (result.status === 'ok') {
        const userInfo = await initialState?.fetchUserInfo?.();
        if (userInfo) {
          flushSync(() => {
            setInitialState((s) => ({ ...s, currentUser: userInfo }));
          });
        }
        const redirect = new URLSearchParams(window.location.search).get('redirect');
        history.push(getSafeRedirectUrl(redirect));
      } else {
        setError(intl.formatMessage({ id: `errors.${result.code}`, defaultMessage: intl.formatMessage({ id: 'pages.login.error.incorrect' }) }));
      }
    } catch {
      message.error(intl.formatMessage({ id: 'pages.login.error.failed' }));
    }
  };

  return (
    <div className={styles.container}>
      <Helmet>
        <title>Login · KPilot</title>
      </Helmet>
      <div style={{ position: 'fixed', top: 12, right: 16 }}>
        <LangDropdown />
      </div>
      <div style={{ flex: 1, padding: '32px 0' }}>
        <LoginForm
          form={form}
          contentStyle={{ minWidth: 280, maxWidth: '75vw' }}
          logo={<img alt="KPilot" src="/logo.svg" />}
          title="KPilot"
          subTitle={intl.formatMessage({ id: 'pages.login.subtitle' })}
          submitter={{ searchConfig: { submitText: intl.formatMessage({ id: 'pages.login.submit' }) } }}
          onFinish={async (values) => {
            await handleSubmit(values as { username: string; password: string });
          }}
        >
          {error && (
            <Alert message={error} type="error" showIcon style={{ marginBottom: 24 }} />
          )}
          {defaults?.usingDefaults && defaults.username && defaults.password && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 24 }}
              message={intl.formatMessage(
                { id: 'pages.login.defaults.hint' },
                { username: defaults.username, password: defaults.password },
              )}
            />
          )}
          <ProFormText
            name="username"
            fieldProps={{ size: 'large', prefix: <UserOutlined /> }}
            placeholder={intl.formatMessage({ id: 'pages.login.username.placeholder' })}
            rules={[{ required: true, message: intl.formatMessage({ id: 'pages.login.username.required' }) }]}
          />
          <ProFormText.Password
            name="password"
            fieldProps={{ size: 'large', prefix: <LockOutlined /> }}
            placeholder={intl.formatMessage({ id: 'pages.login.password.placeholder' })}
            rules={[{ required: true, message: intl.formatMessage({ id: 'pages.login.password.required' }) }]}
          />
        </LoginForm>
      </div>
      <Footer />
    </div>
  );
}
