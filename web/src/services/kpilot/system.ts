import { request } from '@umijs/max';

export function getVersion() {
  return request<{ version: string }>('/api/v1/version', { method: 'GET' });
}
