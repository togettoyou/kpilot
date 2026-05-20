# 模型服务（`/models`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。

全局模型平台（不绑定特定集群）。当前覆盖范围 = 模型仓库（catalog + CRUD）；模型部署 / 调试 / 路由在后续版本逐步落地。

| 模块 | 状态 |
|---|---|
| **模型仓库** | ✅ P15 已落地 |
| **模型部署** | ✅ P16-A 已落地（不含 chat 调试 / 反代）|
| **在线 chat 调试** | 🚧 P16-B 待开始 |
| **OpenAI 兼容反代 endpoint** | 🚧 P16-C 待开始 |
| **OpenAI 兼容路由（按 model 灰度 / A/B）** | 📋 P17 待规划 |
| **分布式 fine-tune（Volcano gang scheduling）** | 📋 P18 待规划 |

不引入 KServe（Knative 依赖过重），P16+ 直接走 Deployment + Service。

---

## 模型仓库（P15 已落地）

全局 `Model` 表 —— 一份注册中心，所有集群的部署向导（P16+）从这里挑模型。

### 数据模型（`pkg/server/store/models.go::Model`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | autoIncrement uint | 主键 |
| `name` | varchar(63) unique | DNS-1123 label，P16+ 直接作 Deployment.metadata.name；小写字母 / 数字 / 连字符 |
| `display_name` | varchar(255) | 卡片 / 表格标题 |
| `description` | varchar(500) | 简介 |
| `family` | enum | `qwen` / `deepseek` / `llama` / `mistral` / `glm` / `yi` / `custom` —— 仅做 UI 分组 |
| `runtime` | enum | `vllm` / `sglang` / `tgi` —— 三家都讲 OpenAI 兼容 HTTP；默认 ship vLLM 预设 |
| `image` | varchar(512) | 完整镜像引用（含 tag）。vLLM 官方为 `vllm/vllm-openai:vX.Y.Z`（当前 seed 用 `v0.20.2`，2026-05 稳定版） |
| `hugging_face_id` | varchar(255) | HF 仓库 id（如 `Qwen/Qwen2.5-7B-Instruct`）。P16 部署时由它构造 `--model` flag |
| `default_args` | text (JSON) | string 数组，如 `["--max-model-len","32768","--dtype","auto"]`；**不要在此放 `--model`**，部署时由 `hugging_face_id` 注入，保证 args 可复用 |
| `recommended_gpu` | text (JSON) | `{"count": N, "memoryGiB": M, "model": "T4\|A10\|A100\|H100\|any"}` —— P16 部署向导用它预填 resources.limits |
| `license` | varchar(64) | 许可证 slug（apache-2.0 / llama3.1 / deepseek / …），仅展示 |
| `is_builtin` | bool | true = seed 内置预设，handler 拒绝 PATCH/DELETE |
| `sort_order` | int | 同 family 内排序（seed 把 7B 排在 14B 前面） |

### REST API

```
GET    /api/v1/models                  # 列表，可选 ?family=&runtime= 过滤
GET    /api/v1/models/:id              # 单个详情
POST   /api/v1/models                  # 创建自定义条目
PATCH  /api/v1/models/:id              # 更新（内置返回 403 MODEL_BUILTIN_LOCKED）
DELETE /api/v1/models/:id              # 删除（内置返回 403 MODEL_BUILTIN_LOCKED）
```

错误码：`MODEL_NOT_FOUND` / `MODEL_NAME_EXISTS` / `MODEL_BUILTIN_LOCKED`，三个前端都有翻译。

### 内置预设（`pkg/server/store/seed_models.go`）

启动时 upsert，覆盖 2026-05 仍在主流使用的开源权重 12 条：

| name | display | family | recommended GPU | license |
|---|---|---|---|---|
| qwen3-0.6b-instruct | Qwen3 0.6B Instruct | qwen | 1 × 4 GiB any | apache-2.0 |
| qwen3-8b-instruct | Qwen3 8B Instruct | qwen | 1 × 24 GiB any | apache-2.0 |
| qwen3-14b-instruct | Qwen3 14B Instruct | qwen | 1 × 40 GiB A100 | apache-2.0 |
| qwen3-32b-instruct | Qwen3 32B Instruct | qwen | 1 × 80 GiB H100 | apache-2.0 |
| qwen3-30b-a3b-instruct | Qwen3 30B-A3B (MoE) | qwen | 1 × 24 GiB any | apache-2.0 |
| deepseek-r1 | DeepSeek R1 | deepseek | 8 × 80 GiB H100 | mit |
| llama-4-scout-17b-16e-instruct | Llama 4 Scout 17B-16E (MoE) | llama | 1 × 80 GiB H100 | llama4 |
| mistral-small-3.2-24b-instruct | Mistral Small 3.2 24B | mistral | 1 × 48 GiB A100 | apache-2.0 |
| phi-4 | Phi-4 14B | phi | 1 × 24 GiB any | mit |
| glm-5.1 | GLM-5.1 | glm | 8 × 80 GiB H100 | mit |
| gemma-4-31b | Gemma 4 31B | gemma | 1 × 80 GiB H100 | apache-2.0 |
| kimi-k2.6 | Kimi K2.6 | kimi | 8 × 80 GiB H100 | modified-mit |

选型依据：HuggingFace trending 2026 H1 / Artificial Analysis Intelligence Index / vLLM release notes 交叉验证。**Qwen3-32B** 被多方报道为 2026 「多数团队的默认选择」（代码生成领先 + Apache 2.0 + 单 H100）；**GLM-5.1** 当前 Intelligence Index 开源权重榜首；**Kimi K2.6** 是 1T MoE 多模态 + Modified MIT。

镜像统一 pin 在 `vllm/vllm-openai:v0.20.2`（2026-05 稳定版）。新增预设只需 append 到 `builtinModels` 切片，启动时自动 upsert。

family 枚举包含 `qwen` / `deepseek` / `llama` / `mistral` / `glm` / `yi` / `phi` / `gemma` / `kimi` / `custom`，新增主流家族时往枚举里加一条 + 在 `web/src/services/kpilot/model.ts::FAMILY_LABELS` 加显示名映射即可。

### 前端（`web/src/pages/ModelHub/`）

- `index.tsx`：ProTable 全表浏览 —— 显示名 + 内部 name + family + runtime + image + HF id + 推荐 GPU + license + 操作列；family / runtime 列内置 filter
- `ModelDrawer.tsx`：新建 + 编辑共用 DrawerForm —— 三段（基本信息 / 运行时 / 调优参数），客户端先解析 JSON 给出可读错误再 submit
- 内置条目 Edit / Delete 按钮禁用 + tooltip 提示「内置不可改」
- 表格下方 Alert banner 列出 P16+ roadmap 模块，对首次访问的用户诚实交代当前覆盖范围

---

---

## 模型部署（P16-A 已落地）

`POST /api/v1/models/:id/deploy` → server 生成 K8s manifests → 通过 worker tunnel 走 `apply` action 推到目标集群。**Model row 是模板**：同一行可独立部署到多个集群，每个集群可起多个 instance。

### 生成什么

按顺序 apply：

1. **Namespace**（仅当 `create_namespace=true` 且不存在 —— 用 `app.kubernetes.io/managed-by=kpilot` 标记）
2. **PersistentVolumeClaim**（仅当 `pvc.enabled=true` —— RWO, ReclaimPolicy=Retain, mount 到 `/root/.cache/huggingface`）
3. **Secret**（仅当传了 `hf_token` —— `Opaque` 类型，键 `HF_TOKEN`，容器走 `envFrom` 拿）
4. **Deployment**（vLLM/SGLang/TGI 容器 + GPU resources + dshm tmpfs 2 GiB + readiness probe）
5. **Service**（ClusterIP, port 8000）

### Deployment.metadata.name 规则

| instance 字段 | Deployment 名 | 用途 |
|---|---|---|
| 空 | `{model.name}` | 单实例，最常见 |
| 非空（DNS-1123 label，≤30 char）| `{model.name}-{instance}` | 同集群多变体共存（prod / canary / long-context 等）|

重复部署到同名 = **SSA update**，不是报错，也不是创建新 instance。

### GPU 资源 plumbing

`gpu_type` 字段二选一：

- `nvidia`（默认）→ `resources.limits['nvidia.com/gpu']: N` —— 通用，所有 NVIDIA device plugin 都认
- `volcano` → `resources.limits['volcano.sh/vgpu-number']: N` —— 需要 `volcano-vgpu-device-plugin` 已安装（KPilot 内置插件），支持单卡切多 Pod

### KPilot 标签集（每个 manifest 都打）

```yaml
labels:
  app.kubernetes.io/managed-by: kpilot
  app.kubernetes.io/name: {model.name}           # 不含 instance 后缀，便于跨实例 list
  app.kubernetes.io/instance: {deployment.name}  # 含后缀
  app.kubernetes.io/component: inference
  kpilot.io/model-id: "{id}"                     # 反查 catalog row
  kpilot.io/model-family: qwen | deepseek | ...
  kpilot.io/model-runtime: vllm | sglang | tgi
  kpilot.io/instance-suffix: ""                  # 空 = singleton
```

**部署状态 = 集群是 source of truth，DB 不存 ModelDeployment 表**。后续要"列出我管的部署"走 K8s label selector `app.kubernetes.io/managed-by=kpilot` 即可，KPilot DB 即使丢失也能自动恢复"我管这些"的认知。

### Dry-run 预览

`POST /api/v1/models/:id/deploy?dry_run=true` —— 同 payload，但 server 只生成 manifests + YAML 文本，不下发到集群。前端 DeployDrawer 的「YAML 预览」tab 走这个。

### 限制 / 已知边界

- `replicas` ≤ 32 / `gpu_count` ≤ 16 / `pvc.size_gib` ≤ 4096（4 TiB） —— 防 typo
- 不挂 PVC 时 vLLM 走 emptyDir，**容器重启会重新下载权重**（drawer 有 Warning 提示）
- 冷启动慢：drawer 提示用户跳转到 `/clusters/:id/workloads/deployments` 看 Pod 起来
- 暂未支持多节点 tensor-parallel（>1 Pod 协同）—— P18 训练任务那边再说

---

## 命名 + 路径约定

- ⚠️ **路径**：组件落在 `pages/ModelHub/` 而非 `pages/Models/`。Umi 的 plugin-model 自动扫描 `src/pages/**/models/**` 当 state-hook 文件，macOS 大小写不敏感 FS 上 `Models` 会命中 glob 触发 CaseSensitivePathsPlugin 报错。
- ⚠️ **field 命名**：API 一律 snake_case（`display_name` / `hugging_face_id` / `default_args` / `recommended_gpu` / `is_builtin`）—— 与 GORM 列名 + 现有 Plugin/Cluster API 保持一致。前端 service 类型镜像同样字段名，不在传输层 camelCase 转换。
