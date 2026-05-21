# 模型服务（`/models`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。

全局模型平台（不绑定特定集群）。当前覆盖范围 = 模型仓库（catalog + CRUD）；模型部署 / 调试 / 路由在后续版本逐步落地。

| 模块 | 状态 |
|---|---|
| **模型仓库** | ✅ P15 已落地 |
| **模型部署** | ✅ P16-A 已落地（不含 chat 调试 / 反代）|
| **模型实例 + 模型调试** | ✅ P16-B 已落地 |
| **OpenAI 兼容反代 endpoint + 真正的 SSE 流式底座** | ✅ P16-C 已落地 |
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

## 模型实例 + 模型调试（P16-B 已落地）

P16-A 把模型推到集群，但「同一个模型现在跑在哪些集群、什么实例、什么状态」需要自己去翻 workloads 页找。P16-B 给 `/models` 平台加了**三个对等子菜单页**（菜单形式对齐 集群管理 / 算力调度），不再走"卡片 + 抽屉链"的交互：

```
模型服务 (/models)
├── 模型仓库   /models/catalog       ← 现有家族分组卡片
├── 模型实例   /models/deployments   ← 跨模型 + 跨集群一张大表
└── 模型调试   /models/chat          ← 全屏 playground
```

**为什么改成菜单**：跨模型的"我现在所有推理在哪"和 chat playground 都是天然全平台视角的；早期版本用 per-model drawer 强行切片，每点开一个 Model 都要重新 fan-out 一次、跨模型之间不连通。Deploy / Edit / Duplicate / Delete 留 drawer（针对一行的 form 动作，跟 workloads 页 ApplyYaml drawer 同模式），不值得开 page。

### 数据模型 —— **零状态新表**

不引入 `ModelDeployment` 表。P16-A 的生成器已经在每个 manifest 上打了完整标签集（[`buildLabels`](../pkg/server/deploy/generator.go) `app.kubernetes.io/managed-by=kpilot` + `app.kubernetes.io/component=inference` + `kpilot.io/model-id=<numeric id>` + `kpilot.io/model-family` + `kpilot.io/model-runtime` + `kpilot.io/instance-suffix`），**集群本身是 source of truth** —— 用户在 kubectl 删了或者外面重命名了，下次刷新页面就自然不显示。这是 P16-A 设计时就锚定的方向，到这里收割红利。

### 跨集群 fan-out 端点

`GET /api/v1/models/deployments[?model_id=N]` —— `pkg/server/api/handler/model_deploy.go::ListAllDeployments`。**一个端点两种模式**：无参数 = 跨模型全集（部署实例页用），`?model_id=N` = 单模型过滤（未来 ModelDetailDrawer 复用）。

- selector 永远带 `app.kubernetes.io/managed-by=kpilot,app.kubernetes.io/component=inference`，再可选 `,kpilot.io/model-id=N` 收紧
- 启动时一次性 `store.ListModels("","")` 装进 `modelsByID map[uint]*store.Model`，**避免 N+1 DB 查询** —— 几十行模型 / 0-200 行 Deployment 的规模一次 map 解决
- 遍历 `store.ListClusters()`；offline worker（`gw.GetWorker(id)` 找不到）**直接跳过**，不计入 errors
- 每个在线 cluster 起一个 goroutine，8s 超时单独 ctx；`list-full apps/v1 Deployment` + 上述 selector
- 用 list-full 而不是 Table API —— 我们需要 `spec.replicas` + `status.{ready,unavailable}Replicas` + `spec.template.spec.containers[0].image`，Table 投影都把这些剥掉了
- 每行 enrich：从 `kpilot.io/model-id` label 解析 ID → map lookup 拿 `ModelDisplayName / Family / Runtime / ModelField`；catalog 行被删了的孤立 deployment 保留显示（ModelID=0 + DisplayName 回退 deployment 名 + 前端打「孤立」Tag），仍能 Delete 清理
- **`ModelField` = 推理后端能识别的模型名**：vLLM 启动用 `--model <HuggingFaceID>`，OpenAI 兼容 chat 请求 body 里的 `model` 字段必须**完全等于**这个值（vLLM 会用 `{"error":{"message":"The model X does not exist.","code":404}}` 拒绝任何其它值）。server 端按 `HuggingFaceID || deployment.name` 解析后随 instance 一并下发，前端 chat 页直接用，**不在前端做 fallback** —— 客户端猜运行时差异是 P16-B 第一版的 bug 源头
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

`web/config/routes.ts` `/models` 父菜单加 `routes:` 数组（catalog / deployments / chat 三个子项），首次进 `/models` redirect 到 `/models/catalog`。菜单 label 在 `locales/{zh-CN,en-US}/menu.ts` 的 `menu.models.{catalog,deployments,chat}` 三 key。

**`pages/ModelHub/index.tsx`**（模型仓库 = 现状）：保留家族分组卡片 + 搜索 / 过滤 + Deploy/Edit/Duplicate/Delete drawer。**移除**了原 RocketOutlined「已部署」按钮 + 关联的 `DeploymentsDrawer` / `ChatDrawer` 两个文件（功能搬到平台菜单第二、第三项）。

**`pages/ModelDeployments/index.tsx`**（模型实例 = 新页）：
- `<PageContainer>` + `<ProTable>` 单表平铺所有 instance，column-level filter（Cluster / Runtime / Status）+ family quick-filter `<Tag.CheckableTag>` 行（family 仅显示数据里实际出现的家族，empty 状态隐藏）
- 列：Model (Avatar + display_name + 孤立 Tag) / Runtime / Cluster / Namespace / 部署名 + instance suffix / Status Tag + `ready/total` / Age (sortable) / Actions
- Per-row actions：**模型调试** → `history.push('/models/chat?cluster=...&ns=...&name=...')` 跳过去；**Describe** → 跳 `/clusters/:id/workloads/deployments` 新 tab；**Delete** → 确认 modal 提示「只删除 Deployment，Service/PVC/Secret 留下」
- partial-fail Alert + 顶部 RefreshControl
- 列表只在挂载时拉一次，不自动轮询 —— 跨集群 fan-out 不便宜，churn 也不高

**`pages/ModelChat/index.tsx`**（模型调试 = 新页）：
- 双列布局：左 Card = 目标实例 Select（grouped by model，disabled non-Running rows）+ 系统提示词 textarea + temperature InputNumber + max_tokens InputNumber + 流式说明 Alert；右 Card = 对话区。Row `align="stretch"` + 固定 `height: calc(100vh - 200px)` + 两侧 Card `flex: 1` 等高 —— 早期版本左侧 grow with content / 右侧 fixed viewport height 出现明显错位
- **URL-driven 选择**：`/models/chat?cluster=...&ns=...&name=...` —— 切换 instance 用 `history.push` 推进 URL，方便分享 / 收藏 / 浏览器后退
- 切换 instance 自动清空 history（不同 model 解读相同 history 会出错）
- 0 个部署实例时整页 `<Result>` 引导跳 catalog（不让用户看到一个空 playground）
- 对话气泡：user 右对齐 `colorPrimary` 头像；assistant 左对齐家族色头像；system 灰头像；`whiteSpace:pre-wrap` 保留 LLM markdown 代码块换行（不上 markdown renderer 避免 XSS 风险 + bundle 体积）
- Enter 发送 / Shift+Enter 换行 / IME composition 期间不触发（中文输入正常）
- response 解析双路径兜底：`choices[0].message.content`（chat 路径 vLLM/SGLang/TGI 都遵循）+ `choices[0].text`（legacy completions 兜底）
- **`model` 字段直接用 server 下发的 `instance.model_field`**（= `HuggingFaceID || deployment.name`），**不在前端组合**。vLLM 启动用 `--model <HF id>`，请求里 `model` 字段必须严格匹配（否则 404 `does not exist`）；第一版前端发的是 `deployment.name`，命中这个错误
- 底部 footer：上一轮 token usage（prompt / completion / total）

**三页统一**：`PageContainer` 都设 `breadcrumbRender={false}` + `header.breadcrumb: undefined` 隐藏面包屑 —— 模型服务平台菜单是平的（catalog / deployments / chat 三个对等子项），面包屑只会重复信息。`ModelHub/index.tsx` 同时去掉了原来的「即将推出」roadmap Alert 与 subtitle 末尾「模型部署 / 调试 / 路由在后续版本落地」文案 —— 现在这些功能已经在了，标语过时反而误导用户。

### 限制 / 已知边界

- **删除是 partial**：只删 Deployment；同名 Service / PVC / Secret 留在集群里。文案显式说了。完整级联删除需要 worker 端实现 label-based delete-collection，留给 P16-C
- **chat 历史不持久化**：刷新页面 / 切实例即丢；想保留可后续加 localStorage（key by `cluster_id+namespace+name`），但「调试」语义本来就是 ephemeral，不强需求
- **流式输出**：见上文，P16-C
- **跨 cluster 并发上限**：当前没有；几十集群同时 fan out 会瞬时打满 worker tunnel 配额，需要 `errgroup.WithLimit` 或 channel-based 令牌桶

---

## OpenAI 兼容反代 + 流式底座（P16-C 已落地）

P16-A/B 把模型推到集群并提供浏览器 chat playground,但**外部 client（curl / OpenAI SDK / LangChain / 自家应用）调不动**:playground 走 cookie 鉴权 + buffered 反代,只能在浏览器开着的标签页里用。P16-C 把这两件事一并解决:

1. **传输层加流式底座**:gateway / worker tunnel 之前是 unary 全缓冲设计,vLLM `stream:true` 能跑但所有 token 攒齐才回包,失去流式价值。新增 `SendHTTPRequestStream` 平行 API,wire 协议复用现有 `HTTPResponseStart + BodyChunk* + BodyEnd` 三帧序列,worker 边读边吐。
2. **暴露 OpenAI 兼容 endpoint** `/api/v1/clusters/:id/proxy/inference/:namespace/:name/*subpath`:Bearer 鉴权,每个 APIKey 绑死一个 (cluster, ns, deployment) 三元组,外部 SDK drop-in 可用。
3. **P16-B chat playground 顺便切到流式**:同一个 `SendHTTPRequestStream` 后端,前端从 `umi request`（全缓冲)换成 `fetch + ReadableStream + TextDecoder`,逐 token 渲染 + Stop 按钮 abort。

### 协议改动:`HTTPRequestStart.stream_response`

proto/pilot.proto `HTTPRequestStart` 加 `bool stream_response = 4`,**向后兼容**:老 worker 收到该字段忽略,继续走 buffered;老 server 不发,worker 默认 false。

```protobuf
message HTTPRequestStart {
  string method = 1;
  string url = 2;
  repeated HTTPHeader headers = 3;
  // P16-C:true = worker forward 上游 body 边读边发 BodyChunk;false = 攒齐再回包(Grafana / VM / VL 保持原行为)
  bool stream_response = 4;
}
```

worker `pkg/worker/proxy/http.go` 在 `req.StreamResponse=true` 时不 `io.ReadAll`,改为 32 KiB 缓冲循环 `Read`,每次 Read 返回的字节立刻通过 `SendHTTPResponseChunk` 发出去。配合 `pkg/worker/tunnel/chunked.go` 新增的 `sendHTTPResponseStart` / `sendHTTPResponseChunk` / `sendHTTPResponseEnd` 三个 incremental API。

### Gateway `SendHTTPRequestStream`

`pkg/server/gateway/http_stream.go` 引入 `HTTPStream`:

```go
type HTTPStream struct {
    Status  int32             // from HTTPResponseStart (block until 到达)
    Headers []*proto.HTTPHeader
    Error   string            // worker 端 dispatch 失败时填,Status 通常是 502
    Chunks  <-chan []byte     // BodyChunk 帧实时 push,closed on BodyEnd
    EndErr  <-chan error      // BodyEnd 触发后 single-shot;非 nil = 上游中途截断
    Close()                   // 必须 defer 调用,撤销 session 状态
}
```

session 在 `g.httpStreams[requestID]` 注册,gateway 的 recv 循环(`handleWorkerMessage`)在分发 HttpRespStart / BodyChunk / BodyEnd 时**先 check streaming session 再 fall back 到原 buffered rxAccumulator**,所以两条路径完全独立、互不干扰。

```go
case *proto.WorkerMessage_HttpRespStart:
    if sess, ok := g.getHTTPStream(msg.RequestId); ok {
        sess.start = p.HttpRespStart
        close(sess.started)  // 解阻塞 SendHTTPRequestStream 调用者
    } else {
        w.rxAsm.open(msg.RequestId, rxKindHTTP, p.HttpRespStart)  // buffered
    }
```

session 的 chunks channel buffer 设为 32(2 MiB worst case);`push()` 在满时阻塞**本 worker 的 recv 循环**(其它 worker 不受影响),所以下游 handler **必须** defer `stream.Close()` 否则慢消费者会拖累整 cluster 的请求处理。worker 断开时 `closeAllHTTPStreams` 兜底强制关掉所有 active session,callers 从阻塞态解锁不会卡到 5 min upstream timeout。

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

Token 格式 `kp-sk-<24 字节 crypto/rand base64url>`(~38 字符)。明文**一次性展示**,sha256 入库。

中间件 `pkg/server/api/middleware/bearer_api_key.go`:
- 提取 `Authorization: Bearer ...`(不接受 cookie / query string,单一鉴权通道)
- sha256 后 `store.GetAPIKeyByHash` 查行,**RevokedAt != nil 与 unknown 都 collapse 成同一 401** —— 不给外部攻击者侧信道
- 校验 URL 路径的 `:id/:namespace/:name` 与行 scope 完全相等 —— scope 不匹配返回独立的 `API_KEY_SCOPE_MISMATCH` 码(操作员侧信道,自己排查时有用)
- 异步 `TouchAPIKeyLastUsed`,DB 写失败不影响请求

### REST 表面

```
# 操作员 CRUD(JWT cookie 鉴权)
POST   /api/v1/api-keys         # 返回 {key:{...}, token:"kp-sk-..."} 仅一次
GET    /api/v1/api-keys         # 列表(不含明文),可选 ?cluster_id= 过滤
POST   /api/v1/api-keys/:id/revoke   # 软撤销(RevokedAt=now)
DELETE /api/v1/api-keys/:id     # 硬删除

# 外部 SDK 调用(Bearer 鉴权,不在 JWT-protected group 下)
POST /api/v1/clusters/:id/proxy/inference/:namespace/:name/v1/chat/completions
Authorization: Bearer kp-sk-...
```

P16-C v1 **只给 JSON CRUD,前端 APIKey 管理 UI 延后到 P16-D**。操作员当前用 curl + JWT cookie 管理 key:

```bash
curl -X POST http://localhost:8080/api/v1/api-keys \
  -b kpilot_token=$(cat ~/.kpilot-jwt) \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod-qwen","cluster_id":"...","namespace":"default","deploy_name":"qwen3-0-6b-instruct"}'
```

返回的 `token` 就是明文,只展示一次,丢了只能重新创建。

### 反代 handler

`pkg/server/api/handler/inference_proxy.go::ProxyInferenceOpenAI`:
- request body cap 16 MiB(允许多 MB prompt)
- 仅转发 Content-Type + Accept;Authorization / cookie / 其它 header 全部剥掉(单租户后端,session 信息不漏到 vLLM 容器)
- 总超时 10 min(LLM cold cache / 长上下文),与 P16-B chat 反代一致
- 通过 `SendHTTPRequestStream` 拿到 `*HTTPStream`,共享 helper `writeStreamingResponse` 把 Status + Headers 直接透传 + 每个 chunk Flush。`X-Accel-Buffering: no` 告诉 nginx-ingress 等代理不要 buffer SSE。
- worker dispatch 失败(`stream.Error != ""`)走 502 + `PROXY_UPSTREAM_ERROR`;upstream 中途截断(`<-stream.EndErr` 非 nil)只 log 不 panic —— 这时 HTTP 状态已经 200 + 部分 body 已发,客户端 SDK 自己会感知 SSE 截断

### P16-B chat playground 同步切到流式

`pkg/server/api/handler/model_chat.go::ProxyInference` 改成调 `SendHTTPRequestStream`,复用同一个 `writeStreamingResponse`。鉴权保持 cookie,URL 形态保持 P16-B 的 `/inference/:namespace/:name/*subpath`(无 `/proxy/` 段)。

前端 `web/src/services/kpilot/model.ts` 新增 `streamChatCompletions(target, body, handler, signal)`:
- 用 `fetch` 直接发(umi 的 `request` 会 buffer body,无法流式)
- `response.body.getReader()` + `TextDecoder('utf-8', { stream: true })` 拿 ReadableStream
- 按 `\n\n` 或 `\r\n\r\n` 分 SSE 事件,`data:` 行 JSON.parse 后 `choices[0].delta.content` 触发 `onDelta`,`[DONE]` 或 `finish_reason` 触发 `onDone`,`usage` 触发 `onUsage`
- AbortSignal 支持(Stop 按钮)

`web/src/pages/ModelChat/index.tsx`:
- 发送时**预分配 assistant 气泡**(固定 React key),onDelta 通过函数式 `setHistory((prev) => ...)` append 内容到 last 消息;不预分配会导致 React 反复 remount 气泡丢帧
- "Stop"按钮替换"Send"在 sending=true 时,调 AbortController.abort()
- 移除原 streamNote Alert(P16-B v1 的"当前为非流式"说明已过时)
- 错误处理:AbortError 不算 error(用户主动停止);其它错误丢空 placeholder 避免永久空气泡

### 限制 / 已知边界

- **chunks channel 满时阻塞 recv 循环**:慢消费者会拖累本 worker 的所有请求处理。defer `stream.Close()` 是必须的;client TCP 断开会触发 `c.Request.Context().Done()`,handler 在 select 里检测后 return,deferred Close 撤销 session
- **APIKey 没有配额/计费**:`last_used_at` 只是观察性数据,不限速也不记 token 数。Token usage tracking 留给后续
- **APIKey 没有前端 UI**:P16-C v1 操作员走 curl + JSON;P16-D 加 ProTable 管理页
- **`stream:false` 同源端点也走流式管道**:vLLM 把完整 JSON 一次 Body Write 出来,worker 当一个 BodyChunk 转出,gateway 直接 close chunks + EndErr。SDK 用户感知不到 —— 但 handler/gateway 多走一层 channel。如果出现非 vLLM/SGLang/TGI 后端不支持 chunked 响应导致问题,可以在 handler 层基于 body 内容 sniff `stream:true/false` 决定走哪条路;当前不做
- **`stream.Error` vs 中途截断 endErr 的语义区分**:Start.error 表示 worker 没拿到上游响应(DNS / dial / 503 等),502 给 client;BodyEnd.error 表示已经开始读 body 但中途连接断了,这时 HTTP 200 已发,只能 log

---

## 命名 + 路径约定

- ⚠️ **路径**：组件落在 `pages/ModelHub/` 而非 `pages/Models/`。Umi 的 plugin-model 自动扫描 `src/pages/**/models/**` 当 state-hook 文件，macOS 大小写不敏感 FS 上 `Models` 会命中 glob 触发 CaseSensitivePathsPlugin 报错。
- ⚠️ **field 命名**：API 一律 snake_case（`display_name` / `hugging_face_id` / `default_args` / `recommended_gpu` / `is_builtin`）—— 与 GORM 列名 + 现有 Plugin/Cluster API 保持一致。前端 service 类型镜像同样字段名，不在传输层 camelCase 转换。
