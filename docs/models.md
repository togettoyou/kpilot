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
  kpilot.io/model-runtime: vllm | sglang | tgi
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
- 不挂 PVC 时 vLLM 走 emptyDir，**容器重启会重新下载权重**（drawer 有 Warning 提示）
- 冷启动慢：drawer 提示用户跳转到 `/clusters/:id/workloads/deployments` 看 Pod 起来
- 暂未支持多节点 tensor-parallel（>1 Pod 协同）—— P18 训练任务那边再说

---

## 已部署列表 + Chat 调试（P16-B 已落地）

P16-A 把模型推到集群，但「同一个模型现在跑在哪些集群、什么实例、什么状态」需要自己去翻 workloads 页找。P16-B 在 ModelCard 上点 RocketOutlined 直接看，并且能就地 chat 调试一下确认推理跑起来了。

### 数据模型 —— **零状态新表**

不引入 `ModelDeployment` 表。P16-A 的生成器已经在每个 manifest 上打了完整标签集（[`buildLabels`](../pkg/server/deploy/generator.go) `app.kubernetes.io/managed-by=kpilot` + `kpilot.io/model-id=<numeric id>` + `kpilot.io/model-family` + `kpilot.io/model-runtime` + `kpilot.io/instance-suffix`），**集群本身是 source of truth** —— 用户在 kubectl 删了或者外面重命名了，下次刷新 drawer 就自然不显示。这是 P16-A 设计时就锚定的方向，到这里收割红利。

### 跨集群 fan-out 端点

`GET /api/v1/models/:id/deployments` —— `pkg/server/api/handler/model_deploy.go::ListModelDeployments`：
- 遍历 `store.ListClusters()`；offline worker（`gw.GetWorker(id)` 找不到）**直接跳过**，不计入 errors（cluster 离线在集群管理页本来就显示，这里再喊一遍是噪音）
- 每个在线 cluster 起一个 goroutine，8s 超时单独 ctx，**走新加的 LabelSelector 路径**：`list-full apps/v1 Deployment` + `app.kubernetes.io/managed-by=kpilot,kpilot.io/model-id=<id>`
- 用 list-full 而不是 Table API —— 我们需要 `spec.replicas` + `status.{ready,unavailable}Replicas` + `spec.template.spec.containers[0].image`，Table 投影都把这些剥掉了
- merge：每个 cluster 的命中扁平 append 到 `instances[]`；某个 cluster 出错（worker disconnect / RBAC 缺 apps/v1）落到 `errors[]`，前端按 `cluster_name + error` 渲染顶部黄色 Alert，partial result 仍然可用
- 状态滚动：`Running`（replicas>0 且 ready>=replicas）/ `Failed`（unavailable>0 且 ready==0）/ `Progressing`（其余）—— 这层抽象避免前端反复 walk conditions

### 协议改动 —— `ResourceRequestStart.label_selector`

新加 proto 字段 `string label_selector = 9`（`proto/pilot.proto`），worker 端 [`proxy.listFull`](../pkg/worker/proxy/proxy.go) / `listTable` forward 到 `ListOptions.LabelSelector` / Table API `?labelSelector=` query。原来这个字段不存在 —— 集群管理页其它列表场景没 label 选择需求。

**新加帧字段的回滚 / 兼容性**：老 worker 收到带 `label_selector` 的 Start frame会忽略未识别字段（protobuf 默认行为），列出全集然后被 server 端按 label 过滤会浪费带宽 —— 但 P16-B 的查询命中量小（典型 0-5 个 Deployment），代价可忽略。新 worker 兼容老 server（字段缺省 = 空串 = 不过滤），无回退风险。

### Chat 反代端点

`POST /api/v1/clusters/:id/inference/:namespace/:name/*subpath` —— `pkg/server/api/handler/model_chat.go::ProxyInference`：
- 转发到 `http://<name>.<namespace>.svc.<cluster-domain>:8000/v1<subpath>`，**端口硬编码 8000**（与 `deploy.containerPort` 一致，防止这个端点被改造成通用集群内 HTTP 代理）
- 走 `gw.SendHTTPRequest` 复用现有的 worker tunnel 路径（包括 in-cluster Service URL 路由 / 24h 决策缓存），HTTPS 入站、tunnel gzip 压缩等都白嫖
- 仅转发 `Content-Type` + `Accept` header；KPilot session cookie / Authorization 全部剥掉 —— 推理后端是单租户单镜像，没必要把会话信息泄给用户提供的 container image
- body 上限 2 MiB（防 runaway client）；超时 5min（LLM cold cache 慢，但要有上限防 wedged backend 堆积）
- **流式 = 缓冲**：worker HTTP tunnel 当前是 `HTTPResponse{Body []byte}` 全缓冲设计 —— vLLM `stream:true` 仍能工作（worker 收完整个 SSE 流再一次返回），但**没有逐 token 体验**。短对话回合几秒返回，对 P16-B "调试" 场景够用；真正的 SSE pass-through 是 P16-C，需要给 `HTTPResponse` 加 `IsStream` 标志 + worker 端 chunked 转发

### 前端

**`pages/ModelHub/DeploymentsDrawer.tsx`**（`size=large`）：
- 顶部刷新按钮 + 命中总数 Badge
- 单一 Table 平铺所有 instance（小列表无需 group 折叠）：Status Tag + `ready/total` 比 / Cluster / Namespace / 部署名 + instance suffix / 运行时长 / Actions
- Per-row actions：**Chat 调试**（Running 才 enable，否则 tooltip 提示 "实例就绪后可调试"）/ **Describe**（跳 `/clusters/:id/workloads?type=deployments&q=<name>` 新 tab，不内嵌；二级 drawer 体验臃肿）/ **Delete**（确认 modal 提示「只删除 Deployment，Service/PVC/Secret 留下」—— 用户想完全清理走 workloads 页或 kubectl）
- partial-fail Alert：每条 `cluster_name: error` 列出，UI 不假装"全集群都查了"

**`pages/ModelHub/ChatDrawer.tsx`**（`size=large`）：
- 对话状态仅在 component state，每轮 send 整段 `messages[]` 上传（model 后端没有 session，KPilot 也不存 history）—— 关 drawer = 新会话
- 输入框：Enter 发送 / Shift+Enter 换行 / IME composition 期间 Enter 不触发发送（中文输入正常）
- 消息渲染：user 右对齐 + `colorPrimary` 头像；assistant 左对齐 + 家族色头像（`FAMILY_META[family].color`）；`whiteSpace: pre-wrap` 保留 LLM 常输出的 markdown 代码块换行（不上 markdown 渲染器避免 XSS 风险 + bundle 体积）
- response 解析双路径兜底：`choices[0].message.content`（chat 路径 vLLM/SGLang/TGI 都遵循）+ `choices[0].text`（legacy completions 兜底，万一某 runtime 把 chat 端点路由到 completions）
- 底部 footer：上一轮 token usage（prompt / completion / total）+ 「当前为非流式，P16-C 上线流式」一行说明 banner
- model 字段：`hugging_face_id || name` —— 推理后端不校验值（单模型 Service），但日志里能看到一个识别度高的名字

**`ModelCard.tsx`** 加 `RocketOutlined`「已部署」icon button（在 Deploy 旁），`onViewDeployments` 可选 prop 缺省时按钮隐藏（未来 picker 模式可复用 card 而不显示 dead button）。

### 限制 / 已知边界

- **删除是 partial**：只删 Deployment；同名 Service / PVC / Secret 留在集群里。文案显式说了。完整级联删除需要 worker 端实现 label-based delete-collection，留给 P16-C
- **chat 历史不持久化**：drawer 关闭即丢；想保留可后续加 localStorage（key by `cluster_id+namespace+name`），但「调试」语义本来就是 ephemeral，不强需求
- **流式输出**：见上文，P16-C
- **跨 cluster 并发上限**：当前没有；几十集群同时 fan out 会瞬时打满 worker tunnel 配额，需要 `errgroup.WithLimit` 或 channel-based 令牌桶
- **eager badge count**：ModelCard 上没显示 deployed count（"已部署 (N)"）—— 要么每张卡都触发一次 fetch（贵），要么加 `GET /api/v1/models/deployments/summary` 聚合端点。当前默认 lazy（点了 icon 才 fetch）

---

## 命名 + 路径约定

- ⚠️ **路径**：组件落在 `pages/ModelHub/` 而非 `pages/Models/`。Umi 的 plugin-model 自动扫描 `src/pages/**/models/**` 当 state-hook 文件，macOS 大小写不敏感 FS 上 `Models` 会命中 glob 触发 CaseSensitivePathsPlugin 报错。
- ⚠️ **field 命名**：API 一律 snake_case（`display_name` / `hugging_face_id` / `default_args` / `recommended_gpu` / `is_builtin`）—— 与 GORM 列名 + 现有 Plugin/Cluster API 保持一致。前端 service 类型镜像同样字段名，不在传输层 camelCase 转换。
