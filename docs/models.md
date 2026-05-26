# 模型服务（`/models`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。

全局模型平台（不绑定特定集群）。推理路径完整落地：模型仓库 + 部署 + 实例 + chat 调试 + OpenAI 兼容反代 + APIKey 管理。

| 模块 | 路径 | 状态 |
|---|---|---|
| **模型仓库** | `/models/catalog` | ✅ |
| **推理部署 + dry-run 预览** | catalog 卡片 Deploy drawer | ✅ |
| **模型实例(跨模型 + 跨集群,删除级联清理 Service/PVC/Secret)** | `/models/deployments` | ✅ |
| **模型调试 playground(流式 + tok/s + `<think>` 拆分 + markdown)** | `/models/chat` | ✅ |
| **OpenAI 兼容反代 endpoint + Bearer APIKey + token 计量** | `/api/v1/clusters/:id/proxy/inference/...` | ✅ |
| **APIKey 操作员管理页(含用量列 + 重置)** | `/models/api-keys` | ✅ |

不引入 KServe（Knative 依赖过重），直接走 Deployment + Service。

---

## 模型仓库

全局 `Model` 表 —— 一份注册中心，所有集群的部署向导从这里挑模型。

### 数据模型（`pkg/server/store/models.go::Model`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | autoIncrement uint | 主键 |
| `name` | varchar(63) unique | DNS-1123 label，直接作 Deployment.metadata.name；小写字母 / 数字 / 连字符 |
| `display_name` | varchar(255) | 卡片 / 表格标题 |
| `description` | varchar(500) | 简介 |
| `family` | enum | `qwen` / `deepseek` / `llama` / `mistral` / `glm` / `yi` / `custom` —— 仅做 UI 分组 |
| `runtime` | enum | `vllm` —— 暂只支持 vLLM(OpenAI 兼容 HTTP);枚举留 enum 列方便后续加新 runtime |
| `image` | varchar(512) | 完整镜像引用（含 tag）。vLLM 官方为 `vllm/vllm-openai:vX.Y.Z`（当前 seed 用 `v0.20.2`，2026-05 稳定版） |
| `source` | enum | `huggingface` / `modelscope` / `local_path` / `oci` —— 决定模型文件从哪里加载，详见下方 Source 矩阵 |
| `source_ref` | varchar(255) | HF / ModelScope 仓库 id（如 `Qwen/Qwen2.5-7B-Instruct`）；`local_path` / `oci` 时忽略 |
| `hf_endpoint` | varchar(512) | HF 镜像 URL（如 `https://hf-mirror.com`），仅 `source=huggingface` 时生效。留空走 huggingface.co 默认 |
| `oci_url` | varchar(512) | OCI artifact 引用（如 `ghcr.io/myorg/qwen:v1`），仅 `source=oci` 时生效 |
| `local_path` | varchar(512) | 容器内模型文件的绝对路径（如 `/models/qwen3-0.6b`），仅 `source=local_path` 时生效 |
| `default_args` | text (JSON) | string 数组，如 `["--max-model-len","32768","--dtype","auto"]`；**不要在此放 `--model`**，部署时按 source 自动注入（HF/MS 用 `source_ref`，本地用 `local_path`，OCI 用固定的 `/weights`） |
| `recommended_gpu` | text (JSON) | `{"count": N, "memoryGiB": M, "model": "T4\|A10\|A100\|H100\|any"}` —— 部署向导用它预填 resources.limits |
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
| qwen3-0-6b-instruct | Qwen3 0.6B Instruct | qwen | 1 × 4 GiB any | apache-2.0 |
| qwen3-8b-instruct | Qwen3 8B Instruct | qwen | 1 × 24 GiB any | apache-2.0 |
| qwen3-14b-instruct | Qwen3 14B Instruct | qwen | 1 × 40 GiB A100 | apache-2.0 |
| qwen3-32b-instruct | Qwen3 32B Instruct | qwen | 1 × 80 GiB H100 | apache-2.0 |
| qwen3-30b-a3b-instruct | Qwen3 30B-A3B (MoE) | qwen | 1 × 24 GiB any | apache-2.0 |
| deepseek-r1 | DeepSeek R1 | deepseek | 8 × 80 GiB H100 | mit |
| llama-4-scout-17b-16e-instruct | Llama 4 Scout 17B-16E (MoE) | llama | 1 × 80 GiB H100 | llama4 |
| mistral-small-3-2-24b-instruct | Mistral Small 3.2 24B | mistral | 1 × 48 GiB A100 | apache-2.0 |
| phi-4 | Phi-4 14B | phi | 1 × 24 GiB any | mit |
| glm-5-1 | GLM-5.1 | glm | 8 × 80 GiB H100 | mit |
| gemma-4-31b | Gemma 4 31B | gemma | 1 × 80 GiB H100 | apache-2.0 |
| kimi-k2-6 | Kimi K2.6 | kimi | 8 × 80 GiB H100 | modified-mit |

选型依据：HuggingFace trending 2026 H1 / Artificial Analysis Intelligence Index / vLLM release notes 交叉验证。**Qwen3-32B** 被多方报道为 2026 「多数团队的默认选择」（代码生成领先 + Apache 2.0 + 单 H100）；**GLM-5.1** 当前 Intelligence Index 开源权重榜首；**Kimi K2.6** 是 1T MoE 多模态 + Modified MIT。

镜像统一 pin 在 `vllm/vllm-openai:v0.20.2`（2026-05 稳定版）。新增预设只需 append 到 `builtinModels` 切片，启动时自动 upsert。

family 枚举包含 `qwen` / `deepseek` / `llama` / `mistral` / `glm` / `yi` / `phi` / `gemma` / `kimi` / `custom`，新增主流家族时往枚举里加一条 + 在 `web/src/services/kpilot/model.ts::FAMILY_LABELS` 加显示名映射即可。

### 前端（`web/src/pages/ModelHub/`）

- `index.tsx`：家族分组卡片 catalog（Collapse + 搜索 + license / runtime 过滤）；搜索覆盖 name / display_name / source_ref / oci_url / local_path / description 所有 source 标识字段
- `ModelDrawer.tsx`：新建 + 编辑共用 DrawerForm —— 四段（基本信息 / 运行时 / **模型来源** / 调优参数）；模型来源用 Segmented + ProFormDependency 动态切换字段（HF 多一个 HF endpoint，OCI 用 oci_url，本地用 local_path），客户端先做 JSON / 路径 / OCI ref 正则校验再 submit
- `ModelCard.tsx` / `ModelDetailDrawer.tsx`：按 source 显示对应 identifier，前缀 🤗 / 📦 / 📁 / 🗂 分辨；HF / MS 还给出对应官方页面的超链接
- 内置条目 Edit / Delete 按钮禁用 + tooltip 提示「内置不可改」

### 模型来源（Source）矩阵

`source` 字段控制模型文件从哪里加载，drives 部署生成器的 env / args / volume / initContainer 决策。

| source | --model 值 | 加载方式 | 额外字段 | 部署期 PVC | Token 用途 |
|---|---|---|---|---|---|
| `huggingface` (默认) | `source_ref` | vLLM 启动时从 `HF_ENDPOINT`（或 huggingface.co）下载 | `hf_endpoint`（可选 mirror）| **生成 PVC**（pvc.enabled 控制）`/root/.cache/huggingface` | `registry_token` → `HF_TOKEN` env，gated 模型必填 |
| `modelscope` | `source_ref` | vLLM 设置 `VLLM_USE_MODELSCOPE=True` 走 ModelScope 下载 | — | **生成 PVC** `/root/.cache/modelscope` | `registry_token` → `MODELSCOPE_API_TOKEN` env，私有仓库必填 |
| `local_path` | `local_path` | 操作员预先把模型文件放到集群 PVC 里 | `local_path` 必填（容器内绝对路径） | **复用 PVC**（必填 `local_pvc_name`），read-only mount 在 `path.Dir(local_path)` | 不用 |
| `oci` | `/weights`（固定） | initContainer `ghcr.io/oras-project/oras:v1.2.0` 跑 `oras pull -o /weights <oci_url>` | `oci_url` 必填 | **可选 PVC**（`local_pvc_name`）持久化，否则 emptyDir 每次重启重拉 | 不用（OCI registry auth 走 ORAS 自己的 `.docker/config.json`，目前 MVP 暂不支持 secret 注入） |

`local_path` 的 PVC 挂载示例：catalog 行 `local_path = /models/qwen3`，部署传 `local_pvc_name = my-models-pvc`，则容器内：

```
PVC my-models-pvc   →   mount /models  (read-only)
   存放模型文件      →   /models/qwen3/...
vLLM 启动              →   --model /models/qwen3
```

PVC 内必须按 catalog 行声明的相对路径准备好模型文件。同一 PVC 可放多个模型（`/models/qwen3`, `/models/llama4`...），各 catalog 行只需 `local_path` 不同。

---

## 模型部署

`POST /api/v1/models/:id/deploy` → server 生成 K8s manifests → 通过 worker tunnel 走 `apply` action 推到目标集群。**Model row 是模板**：同一行可独立部署到多个集群，每个集群可起多个 instance。

### 生成什么

按顺序 apply：

1. **Namespace**（仅当 `create_namespace=true` 且不存在 —— 用 `app.kubernetes.io/managed-by=kpilot` 标记）
2. **PersistentVolumeClaim**（仅当 `pvc.enabled=true` **且 source 是 huggingface / modelscope** —— RWO, ReclaimPolicy=Retain, mount 到对应 cache 目录。`local_path` / `oci` 复用 `local_pvc_name` 指定的已有 PVC，不生成新 PVC）
3. **Secret**（仅当 `registry_token` 非空 **且 source 是 hub 类**：HF 用 `HF_TOKEN`，MS 用 `MODELSCOPE_API_TOKEN`；容器走 `envFrom` 拿。`local_path` / `oci` 不生成 Secret）
4. **Deployment**（vLLM 容器 + GPU resources + dshm tmpfs 2 GiB + readiness probe；source=oci 时多一个 `ghcr.io/oras-project/oras` initContainer 跑 `oras pull`）
5. **Service**（ClusterIP, port 8000）

### Deployment.metadata.name 规则

| instance 字段 | Deployment 名 | 用途 |
|---|---|---|
| 空 | `{model.name}` | 单实例，最常见 |
| 非空（DNS-1123 label，≤30 char）| `{model.name}-{instance}` | 同集群多变体共存（prod / canary / long-context 等）|

重复部署到同名 = **SSA update**，不是报错，也不是创建新 instance。

### 容器资源（三层叠加）

| 层 | 字段 | 写入位置 | 备注 |
|---|---|---|---|
| ① CPU / 内存 | `cpu_request` / `cpu_limit` / `memory_request` / `memory_limit`（K8s quantity 字符串如 `"2"` / `"500m"` / `"4Gi"`）| `resources.requests` 与 `resources.limits` 可不同 | 留空 = 不设置该资源，调度器默认。server 经 `resource.ParseQuantity` 校验 |
| ② GPU 数量 | `gpu_count` + `gpu_type` | 二选一资源 key，`limits` only（K8s 在 admission 自动镜像到 requests，extended resource 强制 requests==limits）| `nvidia.com/gpu`（默认）或 `volcano.sh/vgpu-number` |
| ③ Volcano vGPU 子资源 | `vgpu_memory_mib`（每卡 MiB） / `vgpu_cores`（每卡 SM 0-100%）| `limits` only | **仅 `gpu_type=volcano` 时下发**，跟 nvidia 模式无关 |

GPU 资源 plumbing 二选一：

- `nvidia`（默认）→ `resources.limits['nvidia.com/gpu']: N` —— 通用，所有 NVIDIA device plugin 都认
- `volcano` → `volcano.sh/vgpu-number` + 可选 `volcano.sh/vgpu-memory` + 可选 `volcano.sh/vgpu-cores`，要求集群装了 `volcano-vgpu-device-plugin`（KPilot 内置插件），支持单卡切多 Pod

容器还兜底 dshm tmpfs 2 GiB 给 NCCL（多卡 tensor-parallel 必需），readiness probe 打 `/health`、failureThreshold=10 × 30s 等冷启动下载完成。

### KPilot 标签集（每个 manifest 都打）

```yaml
labels:
  app.kubernetes.io/managed-by: kpilot
  app.kubernetes.io/name: {model.name}           # 不含 instance 后缀，便于跨实例 list
  app.kubernetes.io/instance: {deployment.name}  # 含后缀
  app.kubernetes.io/component: inference
  kpilot.io/model-id: "{id}"                     # 反查 catalog row
  kpilot.io/model-family: qwen | deepseek | ...
  kpilot.io/model-runtime: vllm
  kpilot.io/instance-suffix: ""                  # 空 = singleton
```

**部署状态 = 集群是 source of truth，DB 不存 ModelDeployment 表**。后续要"列出我管的部署"走 K8s label selector `app.kubernetes.io/managed-by=kpilot` 即可，KPilot DB 即使丢失也能自动恢复"我管这些"的认知。

### Dry-run 预览

`POST /api/v1/models/:id/deploy?dry_run=true` —— 同 payload，但 server 只生成 manifests + YAML 文本，不下发到集群。前端 DeployDrawer 的「YAML 预览」tab 走这个。

### 前端 DeployDrawer 三 tab

| tab | 行为 |
|---|---|
| 配置 | 表单。Deploy 按钮 `disabled={!isFormReady}`（监听 cluster / namespace / replicas / gpu_count 四个必填字段，4 个 `Form.useWatch` 钩子），表单未填完整不可点 |
| YAML 预览 | 切 tab 时自动调 dry_run（表单 invalid 时显示提示 Alert，不出空编辑器）；表单 `onValuesChange` 失效缓存让下次切 tab 重新拉。复用 `pages/ClusterDetail/Workloads/YamlEditor`（CodeMirror + YAML 高亮 + 主题色） |
| 部署结果 | 仅首次提交后出现的第三个 tab。提交完成后自动切到此处；Alert banner（success / error 色）+ per-doc 表格（错误列 `whiteSpace=pre-wrap` 完整显示 K8s admission webhook 等多行错误）；成功 banner 带「跳转到工作负载」链接 |

**autofill 防御**：HF Token（`Input.Password`）放表单最底部 + `autoComplete="new-password"`，配合 Form 整体 `autoComplete="off"`，避免 Chrome 把"密码字段之前的第一个 input"（Cluster Select）误填为登录用户名。

### 限制 / 已知边界

- `replicas` ≤ 32 / `gpu_count` ≤ 16 / `pvc.size_gib` ≤ 4096（4 TiB） —— 防 typo
- 不挂 PVC 时 vLLM 走 emptyDir，**容器重启会重新下载模型**（drawer 有 Warning 提示）
- 冷启动慢：drawer 提示用户跳转到 `/clusters/:id/workloads/deployments` 看 Pod 起来
- 暂未支持多节点 tensor-parallel（>1 Pod 协同）—— 单 Pod 多卡（tensor-parallel-size）够当前规模

---

## 模型实例 + 模型调试

模型推到集群后，「同一个模型现在跑在哪些集群、什么实例、什么状态」需要自己去翻 workloads 页找体验太差。`/models` 平台改成**三个对等子菜单页**（菜单形式对齐 集群管理 / 算力调度），不走"卡片 + 抽屉链"的交互：

```
模型服务 (/models)
├── 模型仓库   /models/catalog       ← 现有家族分组卡片
├── 模型实例   /models/deployments   ← 跨模型 + 跨集群一张大表
└── 模型调试   /models/chat          ← 全屏 playground
```

**为什么改成菜单**：跨模型的"我现在所有推理在哪"和 chat playground 都是天然全平台视角的；早期版本用 per-model drawer 强行切片，每点开一个 Model 都要重新 fan-out 一次、跨模型之间不连通。Deploy / Edit / Duplicate / Delete 留 drawer（针对一行的 form 动作，跟 workloads 页 ApplyYaml drawer 同模式），不值得开 page。

### 数据模型 —— **零状态新表**

不引入 `ModelDeployment` 表。部署生成器在每个 manifest 上都打了完整标签集（[`buildLabels`](../pkg/server/deploy/generator.go) `app.kubernetes.io/managed-by=kpilot` + `app.kubernetes.io/component=inference` + `kpilot.io/model-id=<numeric id>` + `kpilot.io/model-family` + `kpilot.io/model-runtime` + `kpilot.io/instance-suffix`），**集群本身是 source of truth** —— 用户在 kubectl 删了或者外面重命名了，下次刷新页面就自然不显示。从部署设计起就锚定这个方向，列表页只是收割红利。

### 跨集群 fan-out 端点

`GET /api/v1/models/deployments[?model_id=N]` —— `pkg/server/api/handler/model_deploy.go::ListAllDeployments`。**一个端点两种模式**：无参数 = 跨模型全集（部署实例页用），`?model_id=N` = 单模型过滤（未来 ModelDetailDrawer 复用）。

- selector 永远带 `app.kubernetes.io/managed-by=kpilot,app.kubernetes.io/component=inference`，再可选 `,kpilot.io/model-id=N` 收紧
- handler 启动时一次性 `store.ListModels("","")` 装进 `modelsByID map[uint]*store.Model`，**避免 N+1 DB 查询** —— 几十行模型 / 0-200 行 Deployment 的规模一次 map 解决
- 遍历 `store.ListClusters()`；offline worker（`gw.GetWorker(id)` 找不到）**直接跳过**，不计入 errors
- 每个在线 cluster 起一个 goroutine，8s 超时单独 ctx；`list-full apps/v1 Deployment` + 上述 selector
- 用 list-full 而不是 Table API —— 我们需要 `spec.replicas` + `status.{ready,unavailable}Replicas` + `spec.template.spec.containers[0].image`，Table 投影都把这些剥掉了
- 每行 enrich：从 `kpilot.io/model-id` label 解析 ID → map lookup 拿 `ModelDisplayName / Family / Runtime / ModelField`；catalog 行被删了的孤立 deployment 保留显示（ModelID=0 + DisplayName 回退 deployment 名 + 前端打「孤立」Tag），仍能 Delete 清理
- **`ModelField` = 推理后端能识别的模型名**：vLLM 启动用 `--model <X>` 把 `X` 注册成自己服务的模型名，OpenAI 兼容 chat 请求 body 里的 `model` 字段必须**完全等于**这个值（vLLM 会用 `{"error":{"message":"The model X does not exist.","code":404}}` 拒绝任何其它值）。server 按 source 解析（HF/MS → `source_ref`，本地 → `local_path`，OCI → `/weights`），orphan 行 fallback 到 deployment.name，随 instance 一并下发；前端 chat 页直接用，**不在前端做 fallback** —— 客户端猜 source 差异是早期 bug 源头
- merge：每个 cluster 的命中扁平 append 到 `instances[]`；某个 cluster 出错（worker disconnect / RBAC 缺 apps/v1）落到 `errors[]`，前端按 `cluster_name + error` 渲染顶部黄色 Alert，partial result 仍然可用
- 状态滚动：`Running`（replicas>0 且 ready>=replicas）/ `Failed`（unavailable>0 且 ready==0）/ `Progressing`（其余）—— 这层抽象避免前端反复 walk conditions

### 协议改动 —— `ResourceRequestStart.label_selector`

proto 字段 `string label_selector = 9`（`proto/pilot.proto`），worker 端 [`proxy.listFull`](../pkg/worker/proxy/proxy.go) / `listTable` forward 到 `ListOptions.LabelSelector` / Table API `?labelSelector=` query。集群管理页其它列表场景没 label 选择需求，所以这个字段一直没加 —— 模型实例页第一次用上。

**新加帧字段的回滚 / 兼容性**：老 worker 收到带 `label_selector` 的 Start frame 会忽略未识别字段（protobuf 默认行为），列出全集然后被 server 端按 label 过滤会浪费带宽 —— 但模型实例的查询命中量小（典型 0-5 个 Deployment），代价可忽略。新 worker 兼容老 server（字段缺省 = 空串 = 不过滤），无回退风险。

### Chat 反代端点

`POST /api/v1/clusters/:id/inference/:namespace/:name/*subpath` —— `pkg/server/api/handler/model_chat.go::ProxyInference`：
- 转发到 `http://<name>.<namespace>.svc.<cluster-domain>:8000/v1<subpath>`，**端口硬编码 8000**（与 `deploy.containerPort` 一致，防止这个端点被改造成通用集群内 HTTP 代理）
- 走 `gw.SendHTTPRequestStream`（OpenAI 兼容反代同款）复用 worker tunnel 路径（包括 in-cluster Service URL 路由 / 24h 决策缓存 / tunnel gzip 压缩）
- 仅转发 `Content-Type` + `Accept` header；KPilot session cookie / Authorization 全部剥掉 —— 推理后端是单租户单镜像，没必要把会话信息泄给用户提供的 container image
- 共享 `writeStreamingResponse` helper（Status+Headers 透传 + 每 chunk Flush + `X-Accel-Buffering: no` 头让 nginx-ingress 不 buffer SSE）。前端 fetch + ReadableStream + TextDecoder 解 SSE

### 前端

`web/config/routes.ts` `/models` 父菜单加 `routes:` 数组（catalog / deployments / chat 三个子项），首次进 `/models` redirect 到 `/models/catalog`。菜单 label 在 `locales/{zh-CN,en-US}/menu.ts` 的 `menu.models.{catalog,deployments,chat}` 三 key。

**`pages/ModelHub/index.tsx`**（模型仓库 = 现状）：保留家族分组卡片 + 搜索 / 过滤 + Deploy/Edit/Duplicate/Delete drawer。**移除**了原 RocketOutlined「已部署」按钮 + 关联的 `DeploymentsDrawer` / `ChatDrawer` 两个文件（功能搬到平台菜单第二、第三项）。

**`pages/ModelDeployments/index.tsx`**(模型实例 = 新页):
- `<PageContainer>` + `<ProTable>` 单表平铺所有 instance,column-level filter(Cluster / Runtime / Status)+ family quick-filter `<Tag.CheckableTag>` 行(family 仅显示数据里实际出现的家族,empty 状态隐藏)
- 列:Model (Avatar + display_name + 孤立 Tag) / Runtime / Cluster / Namespace / 部署名 + instance suffix / Status Tag + `ready/total` / Age (sortable) / Actions
- Per-row actions:**模型调试** → `history.push('/models/chat?cluster=...&ns=...&name=...')` 跳过去;**Describe** → 跳 `/clusters/:id/workloads/deployments` 新 tab;**Delete** → 确认 modal + 级联删除全部相关资源(见下)
- **删除级联**:`Promise.allSettled([del(Deployment), del(Service), del(PVC=<name>-hf-cache), del(Secret=<name>-hf)])`。404 容错(没开持久化或没填 HF token 时这些资源根本没创建);非 404 错误聚合成 partial-failure toast 提示用户哪些需要手动清理。Dialog 文案明确告知"将同时删除 Deployment、Service、PVC、HF Token Secret"
- partial-fail Alert + 顶部 RefreshControl
- 列表只在挂载时拉一次,不自动轮询 —— 跨集群 fan-out 不便宜,churn 也不高

**`pages/ModelChat/index.tsx`**(模型调试 = 新页):
- 双列布局:左 Card = 目标实例 Select(grouped by model,disabled non-Running rows)+ 系统提示词 textarea + temperature InputNumber + max_tokens InputNumber;右 Card = 对话区。Row `align="stretch"` + 两侧 Card `flex: 1` 等高
- **URL-driven 选择**:`/models/chat?cluster=...&ns=...&name=...` —— 切换 instance 用 `history.push` 推进 URL,方便分享 / 收藏 / 浏览器后退
- 切换 instance 自动清空 history(不同 model 解读相同 history 会出错)
- 0 个部署实例时整页 `<Result>` 引导跳 catalog(不让用户看到一个空 playground)
- **对话气泡**:user 右对齐 `colorPrimary` 头像;assistant 左对齐家族色头像;system 灰头像
- **Markdown 渲染**(assistant 消息):`react-markdown + remark-gfm` —— 代码块自定义 tinted 背景 + 内联 code + 列表 + 表格 + 删除线 + 任务列表。User / system 保持 plain text(用户输入逐字显示,不让 markdown 改写其意图)
- **`<think></think>` 拆分**:DeepSeek-R1 / Qwen3 reasoning 模型的 chain-of-thought 自动 `splitThink()` 拆出来,渲染到独立 `Collapse` 区。`Collapse` activeKey 跟随 stream 状态 —— 推理中(`</think>` 还没出现)默认展开 + "正在推理…" 提示;`</think>` 出现自动收起,visible answer 开始流出。**`thinkOverride`** state 记录用户手动 toggle,一旦点过就尊重用户选择(不再被流自动覆盖)
- **每轮 token 速率 stats footer**(assistant bubble 下方):`X tok/s · Ys · prompt → completion (total)`。wall-clock 从 send 时间起算,`completion_tokens` / `(elapsedMs / 1000)` 算速率
- **关键 vLLM 协议细节**:request body 必须含 `stream_options: { include_usage: true }`,否则 vLLM `stream=true` **不发**最后那个携带 usage 的 chunk,onUsage 永不触发,tok/s footer 永远空。该 flag 之前漏了被发现
- Enter 发送 / Shift+Enter 换行 / IME composition 期间不触发(中文输入正常)
- 流式解 SSE:`services/kpilot/model.ts::streamChatCompletions` 用 fetch + ReadableStream + TextDecoder 按 `\n\n` 切事件,`data:` 行 JSON.parse `choices[0].delta.content` 触发 `onDelta`,`[DONE]` 或 `finish_reason` 触发 `onDone`,`usage` 触发 `onUsage`。**发送时预分配 assistant 气泡固定 React key**(否则反复 remount 丢帧),onDelta 走函数式 `setHistory((prev) => ...)` append 内容到 last 消息。"Stop" 按钮替换 "Send" 在 sending=true 时,调 `AbortController.abort()`
- **`model` 字段直接用 server 下发的 `instance.model_field`**（server 按 source 解析,详见上一节）,**不在前端组合**。vLLM 启动用 `--model <X>`,请求里 `model` 字段必须严格匹配（否则 404 `does not exist`）;早期前端发的是 `deployment.name`,命中这个错误
- **mount 时 scroll reset**:跟日志页 / GPU 监控页同款修复 —— 遍历 ancestor 把 scrollTop 清零,避免从其他可滚动页面切过来时残留 scrollTop 让 chat wrapper 出 viewport 之外

**三页统一**：`PageContainer` 都设 `breadcrumbRender={false}` + `header.breadcrumb: undefined` 隐藏面包屑 —— 模型服务平台菜单是平的（catalog / deployments / chat 三个对等子项），面包屑只会重复信息。`ModelHub/index.tsx` 同时去掉了原来的「即将推出」roadmap Alert 与 subtitle 末尾「模型部署 / 调试 / 路由在后续版本落地」文案 —— 现在这些功能已经在了，标语过时反而误导用户。

### 限制 / 已知边界

- **删除已经全量级联**(ModelDeployments 页):同时删 Deployment + Service + PVC(`<name>-hf-cache`)+ HF Token Secret(`<name>-hf`),404 容错
- **chat 历史不持久化**：刷新页面 / 切实例即丢；想保留可后续加 localStorage（key by `cluster_id+namespace+name`），但「调试」语义本来就是 ephemeral，不强需求
- **跨 cluster 并发上限**：当前没有；几十集群同时 fan out 会瞬时打满 worker tunnel 配额，需要 `errgroup.WithLimit` 或 channel-based 令牌桶

---

## OpenAI 兼容反代 + 流式底座

浏览器 chat playground 内部走 cookie 鉴权 + worker tunnel,但**外部 client(curl / OpenAI SDK / LangChain / 自家应用)调不动**。三件事一并解决:

1. **传输层加流式底座**:`gateway.SendHTTPRequestStream` 开一条 `STREAM_HTTP_REQUEST` yamux stream,`HTTPRequestStart.stream_response=true` 告诉 worker 用 streaming 模式;worker 边读 upstream body 边把字节直接写进 yamux stream(yamux 内置 4 MiB per-stream flow-control window 自动反压);server 端把 yamux stream 的 `Body` 当 `io.Reader` 用 —— 不再有 chunks channel / accumulator。详见 [docs/transport-v2.md](transport-v2.md)。
2. **暴露 OpenAI 兼容 endpoint** `/api/v1/clusters/:id/proxy/inference/:namespace/:name/*subpath`:Bearer 鉴权,每个 APIKey 绑死一个 (cluster, ns, deployment) 三元组,外部 SDK drop-in 可用。
3. **chat playground 同步切到流式**:同一个 `SendHTTPRequestStream` 后端,前端 `fetch + ReadableStream + TextDecoder` 逐 token 渲染 + Stop 按钮 abort。
4. **Cancel 走 yamux FIN cascade**:前端 Stop / EventSource 关闭 → server `c.Request.Context().Done()` → defer `stream.Close()` → yamux FIN → worker cancel-watcher 1-byte Read 返 EOF → upstream HTTP ctx 撤销 → upstream conn 立即断,不再傻读到 5min 超时。

### 协议:`HTTPRequestStart.stream_response`

`proto/v2/pilot.proto` 的 `HTTPRequestStart` 有 `bool stream_response = 4`:

```protobuf
message HTTPRequestStart {
  string method = 1;
  string url = 2;
  repeated HTTPHeader headers = 3;
  int64 body_size = 5;
  // true = worker 边读上游 body 边把字节直接写 yamux stream;
  // false = worker 攒齐 body 后一次性回包(Grafana / VM / VL 保持原行为)
  bool stream_response = 4;
}
```

worker `pkg/worker/proxy/http.go::handleStreamingResp` 在 `req.StreamResponse=true` 时:
- 派一个 cancel-watcher goroutine 阻塞 1-byte Read 监听 server FIN
- `dispatchForStream(ctx, req)` 拿 upstream `*http.Response`,32 KiB 循环 `hresp.Body.Read` → `st.Writer().Write` —— **直接把字节写进 yamux stream**,yamux flow-control 自动反压
- cancel-watcher EOF 触发 → ctx 撤销 → upstream `http.Request` ctx 撤销 → `hresp.Body.Read` 返错 → 循环退出 → defer `hresp.Body.Close()`

### Gateway `SendHTTPRequestStream`

`pkg/server/gateway/http_stream.go::HTTPStream`:

```go
type HTTPStream struct {
    Status  int32             // 读自 HTTPResponseStart(SendHTTPRequestStream 同步等返回)
    Headers []*pbv2.HTTPHeader
    Error   string            // worker dispatch 失败时填,Status 通常是 502

    // Body 直接是 yamux stream 的 io.Reader —— 不再有 chunks channel /
    // accumulator,io.Copy(dst, stream.Body) 一行搞定。
    Body io.Reader

    // Close 发 yamux FIN 给 worker。MUST defer 调用,否则 worker
    // 端 upstream 等到自己 5min 超时才感知。
    Close()
}
```

`SendHTTPRequestStream` 内部 `Session.Open(...)` 开 stream + WriteMsg(start frame) + 读 HTTPResponseStart 同步返回。**没有 v1 时代的 per-request session 注册表**(`httpStreams[requestID]` / `rxAccumulator` / `closeWorkerHTTPStreams` 全删了)—— yamux 自身的 session.Close cascade 让所有 in-flight stream 立即返错,不需要应用层兜底。

handler 必须 `defer stream.Close()`,且对长时阻塞的 SSE 路径还需要一个 ctx watcher goroutine 把 `c.Request.Context().Done()` 翻译成 `stream.Close()`(yamux Read 不响应 Go ctx,只响应 SetDeadline 或对端 FIN)。模板参考 `pkg/server/api/handler/inference_proxy.go::writeStreamingResponse`。

### 鉴权:`APIKey` 表 + Bearer 中间件

新表 `pkg/server/store/api_key.go`:

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | autoIncrement uint | 主键 |
| `name` | varchar(255) | 操作员可读标签 |
| `token_hash` | varchar(64) unique | sha256(plaintext) hex;DB 永远不存明文 |
| `token_prefix` | varchar(16) | 头 8 字符(如 `kp-sk-Ab`)便于 UI 识别 |
| `cluster_id` / `namespace` / `deploy_name` | varchar(36/63/253) | 鉴权 scope:key 只授权这一个部署 |
| `last_used_at` | nullable timestamp | 中间件异步 bump,**throttle 到 1 写/分钟**(WHERE-clause 守卫,无锁) |
| `revoked_at` | nullable timestamp | 软删除;hard delete 另有 endpoint |
| `prompt_tokens` / `completion_tokens` / `request_count` | int64 default 0 | 生命周期 token / 请求计数。`inference_proxy.go` 每次成功调用后 async `IncrementAPIKeyUsage(prompt, completion, 1)` |
| `usage_reset_at` | nullable timestamp | 操作员主动重置计量窗口的时间戳。`ResetAPIKeyUsage` 端点写入 |

Token 格式 `kp-sk-<24 字节 crypto/rand base64url>`(~38 字符)。明文**一次性展示**,sha256 入库。

中间件 `pkg/server/api/middleware/bearer_api_key.go`:
- 提取 `Authorization: Bearer ...`(不接受 cookie / query string,单一鉴权通道)
- sha256 后 `store.GetAPIKeyByHash` 查行,**RevokedAt != nil 与 unknown 都 collapse 成同一 401** —— 不给外部攻击者侧信道
- 校验 URL 路径的 `:id/:namespace/:name` 与行 scope 完全相等 —— scope 不匹配返回独立的 `API_KEY_SCOPE_MISMATCH` 码(操作员侧信道,自己排查时有用)
- 异步 `TouchAPIKeyLastUsed`,DB 写失败不影响请求

### REST 表面

```
# 操作员 CRUD(JWT cookie 鉴权)
POST   /api/v1/api-keys                       # 返回 {key:{...}, token:"kp-sk-..."} 仅一次
GET    /api/v1/api-keys                       # 列表(不含明文),可选 ?cluster_id= 过滤
POST   /api/v1/api-keys/:id/revoke            # 软撤销(RevokedAt=now)
POST   /api/v1/api-keys/:id/reset-usage       # 用量计数归零 + UsageResetAt=now
DELETE /api/v1/api-keys/:id                   # 硬删除

# 外部 SDK 调用(Bearer 鉴权,不在 JWT-protected group 下)
POST /api/v1/clusters/:id/proxy/inference/:namespace/:name/v1/chat/completions
Authorization: Bearer kp-sk-...
```

操作员日常通过 `/models/api-keys` 页(`pages/APIKeys/index.tsx`)管理:ProTable 列表 + Create Drawer 二级 picker(cluster Select → 该集群下的推理实例 Select,切 cluster 自动 clear deployment 防 scope 错配)+ 签发成功 Modal 一次性展示明文 token(`maskClosable=false` 防误关 + 复制按钮 + curl usage 示例自动拼好完整 URL 与 Bearer header)+ 「**用量**」列显示「N 次 + prompt → completion = total tok」(`formatBigNumber` 在 ≥10k 时自动 k/M/B 压缩) + tooltip 显示是 lifetime 还是 since-reset + 「**重置用量**」per-row 操作(只在 `request_count > 0` 时显示)+ 撤销(软删,保留审计行)/ 删除(硬删)两个 row action。scope 列做 cluster id → name 反查(mount 时 fetch clusters 不靠 drawer 打开才有,首屏不显示 UUID)。

需要脚本化的场景仍可走 curl + JWT cookie：

```bash
curl -X POST http://localhost:8080/api/v1/api-keys \
  -b kpilot_token=$(cat ~/.kpilot-jwt) \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod-qwen","cluster_id":"...","namespace":"default","deploy_name":"qwen3-0-6b-instruct"}'
```

返回的 `token` 就是明文，只展示一次，丢了只能重新创建。

### 反代 handler

`pkg/server/api/handler/inference_proxy.go::ProxyInferenceOpenAI`:
- request body cap 16 MiB(允许多 MB prompt)
- 仅转发 Content-Type + Accept;Authorization / cookie / 其它 header 全部剥掉(单租户后端,session 信息不漏到 vLLM 容器)
- 总超时 10 min(LLM cold cache / 长上下文),与 chat 反代一致
- 通过 `SendHTTPRequestStream` 拿到 `*HTTPStream`,共享 helper `writeStreamingResponse` 把 Status + Headers 直接透传 + 每个 chunk Flush。`X-Accel-Buffering: no` 告诉 nginx-ingress 等代理不要 buffer SSE
- worker dispatch 失败(`stream.Error != ""`)走 502 + `PROXY_UPSTREAM_ERROR`;upstream 中途截断只 log 不 panic —— 这时 HTTP 状态已经 200 + 部分 body 已发,客户端 SDK 自己会感知 SSE 截断
- **用量计量**(详见下一节):`writeStreamingResponse` 内部 `io.TeeReader` side-channel 通过 `usageScanner` 嗅探响应的 `usage` block(SSE 行扫 `data: {... "usage": {...}}` 或 JSON 全 body 解析),返回 `*usageBlock`;handler 拿到后 async 调 `store.IncrementAPIKeyUsage(prompt, completion, 1)` 增量更新对应 APIKey 行的计数列

### 用量计量(token + 请求数)

每个 APIKey 行携带 lifetime 计数(prompt_tokens / completion_tokens / request_count)。前端 APIKeys 页有「用量」列 + 「重置用量」per-row 操作。

- **`usageScanner`**(`pkg/server/api/handler/inference_proxy.go`)双模工作:
  - **SSE**(Content-Type 含 `text/event-stream`):per-line 扫描 `data: {... "usage": {...}}` chunk
  - **JSON**(Content-Type 含 `application/json`):缓冲整个 response body(cap 256 KiB)后 `json.Unmarshal` 拿顶层 `usage`
- **`ensureStreamIncludeUsage`**:vLLM 默认 `stream:true` 不发携带 usage 的终端 chunk,得 client 显式传 `stream_options.include_usage=true`。代理层在收到 stream 请求时自动回填这个 flag(已经显式设了 true/false 的不动 —— 尊重 opt-out),保证第三方 SDK / curl / langchain 也能被正常计量
- **side-channel `io.TeeReader`**:scanner 跟主响应流并行消费同一份 bytes,不阻塞响应路径
- **Counter 增量**(`store.IncrementAPIKeyUsage`):单条 UPDATE 用 `gorm.Expr("prompt_tokens + ?", prompt)` 原子 +=,无锁,async goroutine 执行,DB 慢不会卡 response
- **Reset**(`store.ResetAPIKeyUsage` + `POST /api/v1/api-keys/:id/reset-usage`):零位 + `UsageResetAt = now`,key 本身保持有效
- **GORM AutoMigrate**:`pkg/server/store/db.go` 的 AutoMigrate 列表里已经有 APIKey,server 重启自动加新列

### Chat playground 同步切到流式

`pkg/server/api/handler/model_chat.go::ProxyInference` 调 `SendHTTPRequestStream`，复用同一个 `writeStreamingResponse`。鉴权保持 cookie，URL 形态保持 `/inference/:namespace/:name/*subpath`（无 `/proxy/` 段，便于跟外部 Bearer 鉴权路径区分）。

前端 `web/src/services/kpilot/model.ts` 新增 `streamChatCompletions(target, body, handler, signal)`:
- 用 `fetch` 直接发(umi 的 `request` 会 buffer body,无法流式)
- `response.body.getReader()` + `TextDecoder('utf-8', { stream: true })` 拿 ReadableStream
- 按 `\n\n` 或 `\r\n\r\n` 分 SSE 事件,`data:` 行 JSON.parse 后 `choices[0].delta.content` 触发 `onDelta`,`[DONE]` 或 `finish_reason` 触发 `onDone`,`usage` 触发 `onUsage`
- AbortSignal 支持(Stop 按钮)

`web/src/pages/ModelChat/index.tsx`：
- 发送时**预分配 assistant 气泡**（固定 React key），onDelta 通过函数式 `setHistory((prev) => ...)` append 内容到 last 消息；不预分配会导致 React 反复 remount 气泡丢帧
- "Stop" 按钮替换 "Send" 在 sending=true 时，调 `AbortController.abort()`
- 错误处理：AbortError 不算 error（用户主动停止）；其它错误丢空 placeholder 避免永久空气泡

### 限制 / 已知边界

- **Defer `stream.Close()` 是 hard requirement**:yamux per-stream 4 MiB flow-control window 满了 worker write 会反压(不会卡其它 stream,跟 v1 单 sender 不同),但漏 Close 会让 worker 端 upstream HTTP request 等到自己 5min ctx 才超时撤销 —— 5min 内白白占着 upstream 连接 + worker goroutine。`writeStreamingResponse` 模板里同时 defer Close + 派 ctx watcher,照抄即可
- **APIKey 计量限于累计 token + 请求数**,没有 quota / rate limit / 时间窗口拆分。第三方 SDK / curl 默认都能计量到 token(代理层自动注入 `stream_options.include_usage=true`,见上一节)
- **`stream:false` 同源端点也走流式管道**:vLLM 把完整 JSON 一次 Body Write 出来,server 端 `io.Copy(c.Writer, stream.Body)` 一次性透传 —— SDK 用户感知不到。如果后续接入不支持 chunked 响应的非 vLLM 后端导致问题,可以在 handler 层基于 body 内容 sniff `stream:true/false` 决定走 `SendHTTPRequest`(buffered)还是 `SendHTTPRequestStream`(streaming);当前不做
- **`stream.Error` vs upstream 中途截断的语义区分**:`stream.Error != ""` 表示 worker 没拿到 upstream 响应(DNS / dial / 503 等),502 给 client;upstream Body.Read 中途返错(比如 LLM 容器 OOM 被 kill)时 HTTP 200 已发,server 端 io.Copy 返错,只能 log —— SDK 自己会感知 SSE 截断

---

## 命名 + 路径约定

- ⚠️ **路径**：组件落在 `pages/ModelHub/` 而非 `pages/Models/`。Umi 的 plugin-model 自动扫描 `src/pages/**/models/**` 当 state-hook 文件，macOS 大小写不敏感 FS 上 `Models` 会命中 glob 触发 CaseSensitivePathsPlugin 报错。
- ⚠️ **field 命名**：API 一律 snake_case（`display_name` / `source` / `source_ref` / `hf_endpoint` / `oci_url` / `local_path` / `default_args` / `recommended_gpu` / `is_builtin`）—— 与 GORM 列名 + 现有 Plugin/Cluster API 保持一致。前端 service 类型镜像同样字段名，不在传输层 camelCase 转换。
