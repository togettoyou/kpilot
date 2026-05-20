import { request } from '@umijs/max';

// Closed enums mirror server-side validRuntimes / validFamilies. The
// catalog Select on the frontend uses these arrays so the dropdown
// + backend validator can't drift.
export type ModelRuntime = 'vllm' | 'sglang' | 'tgi';
export type ModelFamily =
  | 'qwen'
  | 'deepseek'
  | 'llama'
  | 'mistral'
  | 'glm'
  | 'yi'
  | 'phi'
  | 'gemma'
  | 'kimi'
  | 'custom';

export const MODEL_RUNTIMES: ModelRuntime[] = ['vllm', 'sglang', 'tgi'];
export const MODEL_FAMILIES: ModelFamily[] = [
  'qwen',
  'deepseek',
  'llama',
  'mistral',
  'glm',
  'yi',
  'phi',
  'gemma',
  'kimi',
  'custom',
];

// Canonical display labels — used by the table filter and the form
// Select. Centralised so the two stay in sync; "custom" is rendered
// via i18n so the dropdown reads natively in CN / EN.
export const FAMILY_LABELS: Record<Exclude<ModelFamily, 'custom'>, string> = {
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  llama: 'Llama',
  mistral: 'Mistral',
  glm: 'GLM',
  yi: 'Yi',
  phi: 'Phi',
  gemma: 'Gemma',
  kimi: 'Kimi',
};

export const RUNTIME_LABELS: Record<ModelRuntime, string> = {
  vllm: 'vLLM',
  sglang: 'SGLang',
  tgi: 'TGI',
};

// Model matches store.Model: hugging_face_id / default_args /
// recommended_gpu are text-typed in DB but the frontend treats them
// as JSON. default_args is JSON-encoded string[]; recommended_gpu is
// a small JSON object — both parsed on demand by the UI (no
// transparent shape transform in the service layer to keep this
// thin).
export interface Model {
  id: number;
  name: string;
  display_name: string;
  description: string;
  family: ModelFamily;
  runtime: ModelRuntime;
  image: string;
  hugging_face_id: string;
  default_args: string; // JSON: string[]
  recommended_gpu: string; // JSON: { count: number; memoryGiB: number; model: string }
  license: string;
  is_builtin: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface RecommendedGPU {
  count: number;
  memoryGiB: number;
  model: string;
}

export type ModelPayload = Omit<
  Model,
  'id' | 'is_builtin' | 'sort_order' | 'created_at' | 'updated_at'
>;

// Optional query filters land in `params` so they only appear in the
// URL when set; useRequest's auto-cache key picks up empty filters
// distinctly from a full list.
export function listModels(params?: { family?: ModelFamily; runtime?: ModelRuntime }) {
  return request<Model[]>('/api/v1/models', { method: 'GET', params });
}

export function getModel(id: number) {
  return request<Model>(`/api/v1/models/${id}`, { method: 'GET' });
}

export function createModel(payload: ModelPayload) {
  return request<Model>('/api/v1/models', { method: 'POST', data: payload });
}

export function updateModel(id: number, payload: ModelPayload) {
  return request<Model>(`/api/v1/models/${id}`, { method: 'PATCH', data: payload });
}

export function deleteModel(id: number) {
  return request<void>(`/api/v1/models/${id}`, { method: 'DELETE' });
}
