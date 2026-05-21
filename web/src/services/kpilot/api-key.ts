// api-key.ts — services for the operator-facing API key CRUD that
// gates the external OpenAI-compatible inference proxy (P16-C/D).
//
// Each row authorises Bearer-token access to exactly ONE inference
// deployment, identified by (cluster_id, namespace, deploy_name).
// The plaintext token is returned ONLY on the create call — the
// table never shows it again, only `token_prefix` (first 8 chars).
//
// All endpoints are operator-only: protected by JWT cookie auth,
// same as cluster / model / plugin CRUD.

import { request } from '@umijs/max';

export interface APIKey {
  id: number;
  name: string;
  token_prefix: string;
  cluster_id: string;
  namespace: string;
  deploy_name: string;
  last_used_at?: string;
  revoked_at?: string;
  created_at: string;
  updated_at: string;
}

// CreateAPIKeyRequest mirrors the handler's wire shape. Scope fields
// are required — keys must be bound to a concrete deployment so a
// leaked token can't be replayed against arbitrary in-cluster
// Services.
export interface CreateAPIKeyRequest {
  name: string;
  cluster_id: string;
  namespace: string;
  deploy_name: string;
}

// CreateAPIKeyResponse carries the one-shot plaintext token. The
// frontend must surface it clearly + offer copy-to-clipboard; it's
// gone after the create dialog closes.
export interface CreateAPIKeyResponse {
  key: APIKey;
  token: string;
}

export function listAPIKeys(clusterId?: string) {
  return request<APIKey[]>('/api/v1/api-keys', {
    method: 'GET',
    params: clusterId ? { cluster_id: clusterId } : undefined,
  });
}

export function createAPIKey(data: CreateAPIKeyRequest) {
  return request<CreateAPIKeyResponse>('/api/v1/api-keys', {
    method: 'POST',
    data,
  });
}

// revokeAPIKey is idempotent — re-revoking a revoked key is a no-op
// on the server. Soft delete: row stays in the table for audit, but
// the middleware rejects auth.
export function revokeAPIKey(id: number) {
  return request(`/api/v1/api-keys/${id}/revoke`, { method: 'POST' });
}

// deleteAPIKey is hard delete — the row is gone forever. Use for
// test artifacts that shouldn't clutter the operator's list. From
// the middleware's perspective revoke + delete are equivalent (both
// 401 the next request); delete just doesn't leave audit history.
export function deleteAPIKey(id: number) {
  return request(`/api/v1/api-keys/${id}`, { method: 'DELETE' });
}
