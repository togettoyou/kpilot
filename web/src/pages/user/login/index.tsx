import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { LoginForm, ProFormText } from '@ant-design/pro-components';
import { Helmet, useModel } from '@umijs/max';
import { Alert, App } from 'antd';
import { createStyles } from 'antd-style';
import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { Footer } from '@/components';
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
        setError(result.message || 'Incorrect username or password');
      }
    } catch {
      message.error('Login failed, please try again');
    }
  };

  return (
    <div className={styles.container}>
      <Helmet>
        <title>Login · KPilot</title>
      </Helmet>
      <div style={{ flex: 1, padding: '32px 0' }}>
        <LoginForm
          contentStyle={{ minWidth: 280, maxWidth: '75vw' }}
          logo={<img alt="KPilot" src="/logo.svg" />}
          title="KPilot"
          subTitle="Kubernetes-native GPU Orchestration"
          submitter={{ searchConfig: { submitText: 'Login' } }}
          onFinish={async (values) => {
            await handleSubmit(values as { username: string; password: string });
          }}
        >
          {error && (
            <Alert
              message={error}
              type="error"
              showIcon
              style={{ marginBottom: 24 }}
            />
          )}
          <ProFormText
            name="username"
            fieldProps={{ size: 'large', prefix: <UserOutlined /> }}
            placeholder="Username"
            rules={[{ required: true, message: 'Please enter your username' }]}
          />
          <ProFormText.Password
            name="password"
            fieldProps={{ size: 'large', prefix: <LockOutlined /> }}
            placeholder="Password"
            rules={[{ required: true, message: 'Please enter your password' }]}
          />
        </LoginForm>
      </div>
      <Footer />
    </div>
  );
}
