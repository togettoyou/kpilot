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
  // Lifetime usage metering — bumped by the inference proxy on
  // every authenticated call. Tokens columns only advance when
  // the upstream returned a `usage` block (third-party SDKs that
  // don't set stream_options.include_usage leave them at 0 even
  // though request_count still increments).
  prompt_tokens: number;
  completion_tokens: number;
  request_count: number;
  usage_reset_at?: string;
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

// resetAPIKeyUsage zeroes the lifetime token / request counters
// and stamps usage_reset_at = now. Operator-driven; useful for
// monthly quota resets or post-incident cleanup. The key itself
// stays valid — only the metering window starts fresh.
export function resetAPIKeyUsage(id: number) {
  return request(`/api/v1/api-keys/${id}/reset-usage`, { method: 'POST' });
}

// deleteAPIKey is hard delete — the row is gone forever. Use for
// test artifacts that shouldn't clutter the operator's list. From
// the middleware's perspective revoke + delete are equivalent (both
// 401 the next request); delete just doesn't leave audit history.
export function deleteAPIKey(id: number) {
  return request(`/api/v1/api-keys/${id}`, { method: 'DELETE' });
}
