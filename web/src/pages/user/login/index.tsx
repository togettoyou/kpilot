import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { LoginForm, ProFormText } from '@ant-design/pro-components';
import { Helmet, useIntl, useModel } from '@umijs/max';
import { Alert, App } from 'antd';
import { createStyles } from 'antd-style';
import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { Footer, LangDropdown } from '@/components';
import { login } from '@/services/kpilot/auth';

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
        const redirect = new URL(window.location.href).searchParams.get('redirect');
        window.location.href = getSafeRedirectUrl(redirect);
      } else {
        setError(result.message || intl.formatMessage({ id: 'pages.login.error.incorrect' }));
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
