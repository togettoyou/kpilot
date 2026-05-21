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

// FAMILY_META carries everything the catalog UI needs per family:
// canonical display label, an accent color for the letter-avatar
// fallback + section header tint, and (optionally) the iconUrl of
// the maintaining org's HuggingFace avatar. Icons point at HF's CDN
// so we don't hotlink off third-party brand sites + no bundle bloat;
// antd Avatar falls back to the colored letter on load failure.
//
// "custom" stays separate (label resolved via i18n, no logo) so the
// type system keeps it out of the icon-bearing record.
export const FAMILY_META: Record<
  Exclude<ModelFamily, 'custom'>,
  { label: string; color: string; iconUrl: string }
> = {
  qwen: {
    label: 'Qwen',
    color: '#5546B8',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/620760a26e3b7210c2ff1943/-s1gyJfvbE1RgO5iBeNOi.png',
  },
  deepseek: {
    label: 'DeepSeek',
    color: '#0066FF',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/6538815d1bdb3c40db94fbfa/xMBly9PUMphrFVMxLX4kq.png',
  },
  llama: {
    label: 'Llama',
    color: '#1877F2',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/646cf8084eefb026fb8fd8bc/oCTqufkdTkjyGodsx1vo1.png',
  },
  mistral: {
    label: 'Mistral',
    color: '#FF7000',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/634c17653d11eaedd88b314d/9OgyfKstSZtbmsmuG8MbU.png',
  },
  glm: {
    label: 'GLM',
    color: '#00B6CB',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/62dc173789b4cf157d36ebee/i_pxzM2ZDo3Ub-BEgIkE9.png',
  },
  yi: {
    label: 'Yi',
    color: '#B100E8',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/6536187279f1de44b5e02d0f/-T8Xw0mX67_R73b7Re1y-.png',
  },
  phi: {
    label: 'Phi',
    color: '#00A4EF',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/1583646260758-5e64858c87403103f9f1055d.png',
  },
  gemma: {
    label: 'Gemma',
    color: '#4285F4',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/WtA3YYitedOr9n02eHfJe.png',
  },
  kimi: {
    label: 'Kimi',
    color: '#FFB400',
    iconUrl:
      'https://cdn-avatars.huggingface.co/v1/production/uploads/641c1e77c3983aa9490f8121/X1yT2rsaIbR9cdYGEVu0X.jpeg',
  },
};

// FAMILY_LABELS kept as a thin label-only view so callers that only
// need the display string don't have to destructure FAMILY_META.
// Built from FAMILY_META so the two can't drift.
export const FAMILY_LABELS: Record<Exclude<ModelFamily, 'custom'>, string> =
  Object.fromEntries(
    Object.entries(FAMILY_META).map(([k, v]) => [k, v.label]),
  ) as Record<Exclude<ModelFamily, 'custom'>, string>;

export const RUNTIME_LABELS: Record<ModelRuntime, string> = {
  vllm: 'vLLM',
  sglang: 'SGLang',
  tgi: 'TGI',
};

// RUNTIME_DEFAULTS — image + default_args templates per runtime. The
// create drawer pulls from this map both for the initial form values
// and for auto-swap when the user changes the runtime Select (only in
// new mode — edit mode preserves whatever the row already has). Args
// are JSON-encoded strings to match the wire format on the model.
//
// vLLM / SGLang / TGI all speak OpenAI-compatible HTTP, but their CLI
// flags differ. None of these include the model-path flag (vLLM
// `--model`, SGLang `--model-path`, TGI `--model-id`) — those get
// injected at P16+ deploy time from `hugging_face_id` so a custom
// row pointing at a local checkpoint can reuse the same tuning.
//
// Image versions cross-checked 2026-05:
//   - vLLM v0.20.2 stable (vllm-project/vllm releases)
//   - SGLang v0.4.10.post2-cu126 stable (lmsysorg/sglang docker hub)
//   - TGI 3.3.5 latest; project is in maintenance mode as of 2025-12,
//     supported here for legacy deployments but most teams now move
//     to vLLM/SGLang
export const RUNTIME_DEFAULTS: Record<
  ModelRuntime,
  { image: string; defaultArgs: string }
> = {
  vllm: {
    image: 'vllm/vllm-openai:v0.20.2',
    defaultArgs:
      '["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]',
  },
  sglang: {
    image: 'lmsysorg/sglang:v0.4.10.post2-cu126',
    defaultArgs:
      '["--context-length","32768","--mem-fraction-static","0.9","--host","0.0.0.0","--port","30000"]',
  },
  tgi: {
    image: 'ghcr.io/huggingface/text-generation-inference:3.3.5',
    defaultArgs:
      '["--max-input-length","4096","--max-total-tokens","8192","--num-shard","1"]',
  },
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

// ─── Deploy (P16-A) ─────────────────────────────────────────────

export type DeployGPUType = 'nvidia' | 'volcano';

export interface DeployPVC {
  enabled: boolean;
  size_gib: number;
  storage_class_name?: string;
}

export interface DeployPayload {
  cluster_id: string;
  namespace?: string;
  create_namespace?: boolean;
  instance?: string; // optional DNS-1123 label; empty = singleton {model.name}
  replicas: number;
  gpu_count: number;
  gpu_type: DeployGPUType;
  // K8s quantity strings ("2", "500m", "4Gi"); empty omits.
  cpu_request?: string;
  cpu_limit?: string;
  memory_request?: string;
  memory_limit?: string;
  // Volcano vGPU sub-resources — only honored when gpu_type=volcano.
  // vgpu_memory_mib is per-slot MiB, vgpu_cores is 0..100 % of SMs.
  vgpu_memory_mib?: number;
  vgpu_cores?: number;
  hf_token?: string;
  extra_args?: string[];
  pvc: DeployPVC;
}

// Per-doc apply result echoed back from server's applyOneDoc path.
// Frontend uses this to render "Deployment OK · PVC failed (no
// default StorageClass)" instead of a single yes/no.
export interface DeployApplyResult {
  index: number;
  kind: string;
  namespace: string;
  name: string;
  success: boolean;
  error?: string;
}

export interface DeployResponse {
  deployment_name: string;
  namespace: string;
  yaml_preview: string;
  applied: boolean;
  apply_results?: DeployApplyResult[];
}

// deployModel runs the generator + (optionally) the apply path on
// the server. dryRun=true returns just the manifests + YAML for
// the preview tab; dryRun=false (default) applies to the cluster
// and returns per-doc apply results.
export function deployModel(
  id: number,
  payload: DeployPayload,
  dryRun = false,
) {
  return request<DeployResponse>(`/api/v1/models/${id}/deploy`, {
    method: 'POST',
    data: payload,
    params: dryRun ? { dry_run: 'true' } : undefined,
  });
}

// ----- P16-B: cross-cluster deployed instance discovery -----

export type ModelInstanceStatus = 'Running' | 'Progressing' | 'Failed';

export interface ModelInstance {
  // Model identity per row (server enriches via DB lookup so the
  // table doesn't need to fetch the catalog separately). ModelID=0
  // means orphan: deployment exists in cluster but catalog row was
  // deleted — display_name then falls back to deployment name.
  model_id: number;
  model_display_name: string;
  model_family?: string;
  model_runtime?: string;
  // model_field is the exact string the inference Service expects
  // in the chat/completions request body's `model` field — server
  // resolves it from `HuggingFaceID || deployment.name` so the
  // chat page doesn't have to know about runtime quirks.
  model_field: string;

  cluster_id: string;
  cluster_name: string;
  namespace: string;
  name: string;
  instance_suffix: string;
  image?: string;
  replicas: number;
  ready_replicas: number;
  available_replicas: number;
  created_at: string;
  service_port: number;
  status: ModelInstanceStatus;
}

export interface ModelInstanceError {
  cluster_id: string;
  cluster_name: string;
  error: string;
}

export interface ModelInstancesResponse {
  instances: ModelInstance[];
  errors?: ModelInstanceError[];
}

// listDeployments fans out across every online worker server-side.
// No filter = every KPilot-managed inference Deployment across all
// models (used by the platform-level Deployments page). Pass
// modelId to narrow to a single model.
export function listDeployments(opts?: { modelId?: number }) {
  return request<ModelInstancesResponse>('/api/v1/models/deployments', {
    method: 'GET',
    params: opts?.modelId ? { model_id: opts.modelId } : undefined,
  });
}

// ----- P16-B: chat completions reverse proxy -----

// chatCompletions targets the inference Service the deployment
// generator created. Body shape is OpenAI-compat; we don't model
// it here (frontend passes a free object) because vLLM / SGLang /
// TGI each support slightly different extension fields. The
// server proxy is fully buffered so stream:true still works but
// yields a single end-of-turn payload; streaming UI lands in P16-C.
export interface ChatTarget {
  clusterId: string;
  namespace: string;
  name: string;
}

export function chatCompletions<T = unknown>(target: ChatTarget, body: unknown) {
  return request<T>(
    `/api/v1/clusters/${encodeURIComponent(target.clusterId)}/inference/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/chat/completions`,
    {
      method: 'POST',
      data: body,
    },
  );
}

// ----- P16-C: streaming chat completions (SSE) -----
//
// streamChatCompletions opens a `stream:true` chat completion call
// and surfaces each `data: {...}` SSE event back to the caller as a
// per-token delta. We use raw fetch + ReadableStream (not the
// `request` helper from @umijs/max because that buffers the body
// before returning).
//
// The server (handler/model_chat.go::ProxyInference) was rewired in
// P16-C to use gateway.SendHTTPRequestStream end-to-end, so each
// chunk lands in the browser with sub-second latency from the
// upstream vLLM flush. Without this client-side hook we'd still
// hit the buffered path of `request` and lose the live cadence.
//
// Auth: cookie-only (browser session). The OpenAI-compat external
// path uses Bearer tokens at /api/v1/clusters/<id>/proxy/inference/
// — that's a different endpoint shape and not what the playground
// targets.

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamChatHandler {
  // onDelta is fired with each new content fragment from
  // choices[0].delta.content. Called inside a React render cycle —
  // accumulate into local state via the functional setState form
  // so successive deltas don't drop frames.
  onDelta: (text: string) => void;
  // onUsage fires once with the final usage payload, which vLLM
  // emits in the last SSE event (after delta is empty).
  onUsage?: (usage: ChatUsage) => void;
  // onDone fires exactly once — either after the `data: [DONE]`
  // sentinel arrives, or after the stream closes cleanly without
  // a finish_reason (some runtimes elide it). Receives the
  // upstream finish_reason if present (`stop` / `length` / …).
  onDone?: (reason: string | null) => void;
}

// streamChatCompletions resolves when the stream closes cleanly
// (DONE / EOF), or rejects with an Error on HTTP failure / abort /
// truncation. Caller supplies an AbortSignal to cancel mid-stream
// (Stop button in the playground UI).
export async function streamChatCompletions(
  target: ChatTarget,
  body: unknown,
  handler: StreamChatHandler,
  signal?: AbortSignal,
): Promise<void> {
  const url = `/api/v1/clusters/${encodeURIComponent(target.clusterId)}/inference/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Browsers don't send the kpilot_token cookie on cross-origin
    // fetch unless we explicitly include credentials; dev proxy +
    // prod same-origin both work with `include` (no `same-origin`
    // confusion).
    credentials: 'include',
    signal,
  });
  if (!resp.ok) {
    // Try to extract a structured error code; fall back to plain
    // text so the UI sees something useful either way.
    let detail = `HTTP ${resp.status}`;
    try {
      const txt = await resp.text();
      if (txt) detail = txt;
    } catch {
      // ignore; detail keeps the status code only
    }
    throw new Error(detail);
  }
  if (!resp.body) {
    throw new Error('streaming response has no body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let doneFired = false;
  const fireDone = (reason: string | null) => {
    if (doneFired) return;
    doneFired = true;
    handler.onDone?.(reason);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are delimited by a blank line. Some upstreams
      // emit \r\n\r\n; handle both by normalising before split.
      let idx: number;
      let sep: number;
      while (true) {
        const a = buffer.indexOf('\n\n');
        const b = buffer.indexOf('\r\n\r\n');
        if (a < 0 && b < 0) break;
        if (a >= 0 && (b < 0 || a < b)) {
          idx = a;
          sep = 2;
        } else {
          idx = b;
          sep = 4;
        }
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + sep);
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trimStart();
          if (payload === '[DONE]') {
            fireDone(null);
            return;
          }
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{
                delta?: { content?: string };
                text?: string;
                finish_reason?: string | null;
              }>;
              usage?: ChatUsage;
            };
            const choice = obj.choices?.[0];
            const delta = choice?.delta?.content ?? choice?.text;
            if (delta) handler.onDelta(delta);
            if (choice?.finish_reason) {
              fireDone(choice.finish_reason);
            }
            if (obj.usage) handler.onUsage?.(obj.usage);
          } catch {
            // Skip malformed events — vLLM occasionally emits
            // keepalive pings or empty events; ignore rather than
            // tear down the stream.
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if cancelled — fine.
    }
  }
  // Stream closed without an explicit DONE — surface to caller so
  // UI can stop the spinner.
  fireDone(null);
}
