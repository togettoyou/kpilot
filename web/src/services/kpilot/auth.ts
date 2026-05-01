import { request } from '@umijs/max';

export interface CurrentUser {
  name: string;
  access: string;
  avatar?: string;
}

export function login(params: { username: string; password: string }) {
  return request<{ status: 'ok' | 'error'; code?: string; message?: string }>(
    '/api/v1/auth/login',
    { method: 'POST', data: params },
  );
}

export function currentUser() {
  return request<{ data: CurrentUser; success: boolean }>(
    '/api/v1/auth/me',
    { method: 'GET' },
  );
}

export function logout() {
  return request('/api/v1/auth/logout', { method: 'POST' });
}
