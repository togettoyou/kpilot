import { request } from '@umijs/max';

export interface CurrentUser {
  name: string;
  access: string;
  avatar?: string;
  // True when the deployment is still running with the seed
  // ADMIN_PASSWORD. Computed server-side at boot and propagated via
  // /auth/me; the app shell renders a "rotate password" banner when set.
  mustRotatePassword?: boolean;
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

// AuthDefaults reflects whether the server is still running with the
// seed ADMIN_PASSWORD. When true, the login page renders a hint with
// the credentials so first-time users / demo deployments can sign in
// without reading the docs. Once rotated, `usingDefaults` flips to
// false and `username` / `password` are omitted.
export interface AuthDefaults {
  usingDefaults: boolean;
  username?: string;
  password?: string;
}

export function authDefaults() {
  return request<AuthDefaults>('/api/v1/auth/defaults', { method: 'GET' });
}
