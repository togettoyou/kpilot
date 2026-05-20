package store

import (
	"errors"

	"gorm.io/gorm"
)

// builtinModels seeds the P15 catalog with the open-weights presets
// that are actively in production use as of 2026-05. Same shape as
// builtinPlugins — refreshed on every boot so license / arg fixes
// ship with the next deploy, mutation-locked from the UI via
// is_builtin=true.
//
// Picked from cross-checked sources (HuggingFace trending /
// Artificial Analysis intelligence index / vLLM release notes):
//
//   - Qwen3 family — Apache-2.0, "default choice for most teams"
//     per H1-2026 retrospectives; dense 8B/14B/32B + Qwen3-30B-A3B
//     (MoE, 3B active, single-GPU sweet spot)
//   - DeepSeek-R1 — reasoning flagship, MIT license
//   - Llama-4-Scout — Meta's MoE small-experts (17B active / 109B
//     total), fits on one H100 with int4 quant
//   - Mistral-Small-3.2 — latest Apache-2.0 24B with vision +
//     128k context (mistralai 2506 checkpoint)
//   - Phi-4 — Microsoft 14B, MIT, dense, strong reasoning/math
//   - GLM-5.1 — Z.ai's 2026 flagship, leads Artificial Analysis
//     Intelligence Index among open weights
//   - Gemma-4-31B — Google's 2026 dense flagship, Apache-style Gemma terms
//   - Kimi-K2.6 — Moonshot's 1T MoE (32B active), "Modified MIT"
//
// Image pinning:
//   - vllm/vllm-openai:v0.20.2 (stable 2026-05). Newer minor releases
//     drop weekly; pin per-row when a model needs a specific floor.
//
// DefaultArgs convention:
//   - Skip `--model` here — the P16 deployment generator builds it
//     from HuggingFaceID at apply time so a custom row pointing at
//     a local checkpoint can reuse the same tuning flags.
//   - Pin --max-model-len explicitly. Native context windows have
//     grown a lot (Gemma-4 256k, Llama-4 1M+) so the default would
//     be unreasonable for a fresh-out-of-the-box deploy.
//
// RecommendedGPU shape: {"count": N, "memoryGiB": M, "model": "T4|A10|A100|H100|any"}.
// "any" means "anything with enough memory will work"; narrowed
// only when the model legitimately needs tensor cores or NVLink.
var builtinModels = []Model{
	// ─── Qwen3 family (Apache-2.0) ──────────────────────────────
	{
		Name:           "qwen3-0-6b-instruct",
		DisplayName:    "Qwen3 0.6B Instruct",
		Description:    "Smallest Qwen3 dense — 0.8B params actual (the '0.6B' name refers to non-embedding parameter count). At BF16 it's ~1.6 GB VRAM, fits on any GPU including 4 GB cards. Pick this preset to smoke-test the deployment pipeline end-to-end before pulling a real workload.",
		Family:         ModelFamilyQwen,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "Qwen/Qwen3-0.6B",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":4,"model":"any"}`,
		License:        "apache-2.0",
		SortOrder:      5,
	},
	{
		Name:           "qwen3-8b-instruct",
		DisplayName:    "Qwen3 8B Instruct",
		Description:    "Alibaba Qwen3 8B dense — Apache-2.0, supports seamless switch between thinking / non-thinking modes within a single model. Native 32k context (131k with YaRN). Single 24 GB GPU.",
		Family:         ModelFamilyQwen,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "Qwen/Qwen3-8B",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":24,"model":"any"}`,
		License:        "apache-2.0",
		SortOrder:      10,
	},
	{
		Name:           "qwen3-14b-instruct",
		DisplayName:    "Qwen3 14B Instruct",
		Description:    "Mid-size Qwen3 dense — meaningful quality bump over 8B. Single 40 GB A100 at 32k context.",
		Family:         ModelFamilyQwen,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "Qwen/Qwen3-14B",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":40,"model":"A100"}`,
		License:        "apache-2.0",
		SortOrder:      20,
	},
	{
		Name:           "qwen3-32b-instruct",
		DisplayName:    "Qwen3 32B Instruct",
		Description:    "Qwen3's flagship dense — the 2026 default for most teams per H1 retrospectives. Strongest open-weight code model in its class. Single H100 80 GB sufficient at 32k context.",
		Family:         ModelFamilyQwen,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "Qwen/Qwen3-32B",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":80,"model":"H100"}`,
		License:        "apache-2.0",
		SortOrder:      30,
	},
	{
		Name:           "qwen3-30b-a3b-instruct",
		DisplayName:    "Qwen3 30B-A3B Instruct (MoE)",
		Description:    "MoE checkpoint — 30B total / 3B active per token. The perf-per-VRAM sweet spot: matches dense 14B quality on a single 24 GB consumer GPU, with batching headroom.",
		Family:         ModelFamilyQwen,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "Qwen/Qwen3-30B-A3B-Instruct-2507",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":24,"model":"any"}`,
		License:        "apache-2.0",
		SortOrder:      40,
	},

	// ─── DeepSeek family ────────────────────────────────────────
	{
		Name:           "deepseek-r1",
		DisplayName:    "DeepSeek R1",
		Description:    "DeepSeek's reasoning model — performance comparable to OpenAI o1 on math / code / reasoning. 685B total params under MIT (commercial-friendly). Needs 8 × 80 GB for full BF16 or quantize to run on less.",
		Family:         ModelFamilyDeepSeek,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "deepseek-ai/DeepSeek-R1",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--tensor-parallel-size","8","--trust-remote-code","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":8,"memoryGiB":80,"model":"H100"}`,
		License:        "mit",
		SortOrder:      10,
	},

	// ─── Llama 4 family ─────────────────────────────────────────
	{
		Name:           "llama-4-scout-17b-16e-instruct",
		DisplayName:    "Llama 4 Scout 17B-16E Instruct (MoE)",
		Description:    "Meta's small-experts MoE — 17B active / 109B total, 16 experts. Multimodal (text + vision) with early fusion. Fits in a single H100 80 GB with int4 quantization.",
		Family:         ModelFamilyLlama,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "meta-llama/Llama-4-Scout-17B-16E-Instruct",
		DefaultArgs:    `["--max-model-len","131072","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":80,"model":"H100"}`,
		License:        "llama4",
		SortOrder:      10,
	},

	// ─── Mistral family ─────────────────────────────────────────
	{
		Name:           "mistral-small-3-2-24b-instruct",
		DisplayName:    "Mistral Small 3.2 24B Instruct",
		Description:    "Apache-2.0 24B with vision + 128k context (June 2026 checkpoint). The headline mid-tier open-weight; production-friendly license.",
		Family:         ModelFamilyMistral,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":48,"model":"A100"}`,
		License:        "apache-2.0",
		SortOrder:      10,
	},

	// ─── Microsoft Phi family ───────────────────────────────────
	{
		Name:           "phi-4",
		DisplayName:    "Phi-4 14B",
		Description:    "Microsoft Phi-4 dense 14B — MIT licensed, strong math + reasoning per parameter. Synthetic-data heavy training pipeline; beats some 70B baselines on benchmarks while fitting on a single 24 GB GPU.",
		Family:         ModelFamilyPhi,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "microsoft/phi-4",
		DefaultArgs:    `["--max-model-len","16384","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":24,"model":"any"}`,
		License:        "mit",
		SortOrder:      10,
	},

	// ─── Z.ai GLM family ────────────────────────────────────────
	{
		Name:           "glm-5-1",
		DisplayName:    "GLM-5.1",
		Description:    "Z.ai GLM-5.1 — currently leads the Artificial Analysis Intelligence Index among open-weight models. Focused on agentic engineering / coding / long-horizon planning. Heavy MoE — multi-GPU only.",
		Family:         ModelFamilyGLM,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "zai-org/GLM-5.1",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--tensor-parallel-size","8","--trust-remote-code","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":8,"memoryGiB":80,"model":"H100"}`,
		License:        "mit",
		SortOrder:      10,
	},

	// ─── Google Gemma family ────────────────────────────────────
	{
		Name:           "gemma-4-31b",
		DisplayName:    "Gemma 4 31B",
		Description:    "Google's 2026 dense flagship — 31B params, 256k context, multimodal. Multilingual support across 140+ languages. Gemma 4 dropped the custom Gemma Terms in favor of true Apache 2.0.",
		Family:         ModelFamilyGemma,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "google/gemma-4-31B",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":1,"memoryGiB":80,"model":"H100"}`,
		License:        "apache-2.0",
		SortOrder:      10,
	},

	// ─── Moonshot Kimi family ───────────────────────────────────
	{
		Name:           "kimi-k2-6",
		DisplayName:    "Kimi K2.6",
		Description:    "Moonshot AI's flagship — 1T total / 32B active MoE, native multimodal, agentic. Heavy — multi-GPU only. Modified MIT license adds extra terms above 100M MAU; below that threshold it behaves like vanilla MIT.",
		Family:         ModelFamilyKimi,
		Runtime:        ModelRuntimeVLLM,
		Image:          "vllm/vllm-openai:v0.20.2",
		HuggingFaceID:  "moonshotai/Kimi-K2.6",
		DefaultArgs:    `["--max-model-len","32768","--dtype","auto","--tensor-parallel-size","8","--trust-remote-code","--gpu-memory-utilization","0.9"]`,
		RecommendedGPU: `{"count":8,"memoryGiB":80,"model":"H100"}`,
		License:        "modified-mit",
		SortOrder:      10,
	},
}

// SeedBuiltinModels upserts the catalog presets on startup. Same
// idempotent shape as SeedBuiltinPlugins — built-ins are keyed by
// `name`, existing rows refresh to match the latest hard-coded
// definition so doc/license/arg fixes ship with the next deploy.
func SeedBuiltinModels(db *gorm.DB) error {
	for _, want := range builtinModels {
		want.IsBuiltin = true
		var existing Model
		err := db.Where("name = ?", want.Name).First(&existing).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			if err := db.Create(&want).Error; err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			updates := map[string]any{
				"display_name":    want.DisplayName,
				"description":     want.Description,
				"family":          want.Family,
				"runtime":         want.Runtime,
				"image":           want.Image,
				"hugging_face_id": want.HuggingFaceID,
				"default_args":    want.DefaultArgs,
				"recommended_gpu": want.RecommendedGPU,
				"license":         want.License,
				"is_builtin":      true,
				"sort_order":      want.SortOrder,
			}
			if err := db.Model(&existing).Updates(updates).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
