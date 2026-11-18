---
kind: upgrade-guide
description: "pi-ai 1.3.0 改变了提供方协议、推理选项、历史回放以及无效工具参数的处理方式。"
---

# pi-ai 1.3.0 协议与回放变更

[English](guide.md) | 中文

## 变更

pi-ai 从 1.1.0 升级到 1.3.0 时改变了以下默认行为。显式 profile 覆盖值仍然优先。

| 路由或行为 | 新行为 |
|---|---|
| `kimi-coding` | 使用 `https://api.kimi.com/coding/v1` 上的 `openai-completions`，替代 `/coding` 上的 `anthropic-messages` |
| `opencode`、`opencode-go` | 端点将 `/zen` 替换为 `/inference`；`/go` 和 `/v1` 后缀仍由模型决定 |
| Xiaomi MiMo 目录，包括 token-plan 路由 | 只提供 `off` 和 `high` 推理选项 |
| `kimi-coding/kimi-for-coding-highspeed` | 不提供推理 `off` 选项 |
| assistant 推理历史 | 发出的请求会省略来自另一提供方、API 或模型的思考，而不再将其转换为文本；缺少原生元数据的降级回放也会省略思考 |
| 已完成调用的工具参数无效 | 本次尝试以 `MALFORMED_RESPONSE` 失败，不执行任何工具，也不发布成功的回放状态。默认的普通重试策略不重试此错误码 |

存储的历史保持不变。切回原模型时会恢复其有效的原生回放元数据。达到 token 限制而截断的输出仍会丢弃未完成的工具调用，并可正常续写。凭据无需迁移。

## 迁移

1. 检查 `cordis.patch.yml` 中的 `providers.<provider>.baseURL`、`api` 和 `compat` 覆盖配置。对于跟随上游 Kimi Coding 端点的覆盖配置，使用 Completions 协议和 `/v1` 路径。自定义网关必须显式保留其实际协议和路径。按需将 OpenCode URL 更新为 `/inference`。若希望使用目录默认值，请省略覆盖配置。
2. 将 profile、preset 和 Session 中不受支持的推理选项替换为当前模型元数据列出的级别。
3. 将切换模型后仍需要的事实放入用户消息或普通 assistant 回复；不要依赖先前的私有推理转换为可见文本。
4. 出现 `MALFORMED_RESPONSE` 时，检查诊断中的无效参数，并修正模型或网关输出。用一个简短提示和一次工具调用验证受影响的路由。参见[配置参考](../../../../packages/llm/llm-pi-ai/README.zh.md)。
