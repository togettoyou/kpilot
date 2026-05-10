# 模型管理（`/models`，P7）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档为 P7 模块占位 + 落地计划。

全局模型平台（不绑定特定集群）。当前仅 landing 占位页，列出四个待实现模块：

- **模型仓库**：全局 `Model` 表（name / runtime=`vllm|sglang|tgi` / image / default_args / recommended_gpu）。内置预设若干（Qwen / DeepSeek / Llama 等）
- **模型部署**：选模型 + 选集群 + GPU 数 + 副本数 → 后端构造 Deployment + Service manifest → SSA 到目标集群。可选启用 KPilot 反代（路径 `/api/v1/clusters/:id/proxy/inference/<deploy-name>`）暴露 OpenAI-compat API
- **调试 chat**：抽屉打开简易 chat UI → 调用已部署 endpoint → 流式返回
- **模型路由**：OpenAI 兼容网关，按 model 参数路由不同后端，支持灰度 / A/B

不引入 KServe（Knative 依赖过重），直接走 Deployment + Service。

> ⚠️ **路径命名**：组件落在 `pages/ModelHub/` 而非 `pages/Models/`。Umi 的 plugin-model 自动扫描 `src/pages/**/models/**` 当 state-hook 文件，macOS 大小写不敏感 FS 上 `Models` 会命中 glob 触发 CaseSensitivePathsPlugin 报错
