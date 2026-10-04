# Agent Note: DeepSeek 请求用户与会话身份头部

Status: implemented
Archived: 2026-09-30

[English](2026-08-11-deepseek-request-user-id-header.md) | 中文

## 问题

当调用方提供 `GenerateOptions.sessionId` 时，直连 DeepSeek 请求已携带 `x-deepseek-harness-session-id`，让提供方侧支持与诊断可以关联同一对话中的多个轮次。但请求缺少跨会话的稳定身份，而 harness 已为遥测与反馈持久化匿名用户 id。另行生成 id 会破坏关联；把它放进提供方无关的归属辅助函数，则会让每个 HTTP 适配器都发送稳定的逐用户标识。

用户 id 是传输元数据，不是模型输入。它不得进入请求体、提示词、token 计量、KV cache 身份或会话日志。发送目标是适配器解析后的 `baseURL`，既可能是 DeepSeek 自身，也可能是配置的网关，因此必须明确隐私边界。

## 决策

`dsh-llm-deepseek` 在凭据解析成功后发出的每个提供方请求上发送 `x-deepseek-harness-user-id`。该值来自 `@deepseek-ai/dsh-anonymous-user-id`，因此与同一 `$DSH_HOME` 的 OpenTelemetry Resource `user.id` 及 `/feedback` 确认一致。适配器继续仅在存在 `GenerateOptions.sessionId` 时发送 `x-deepseek-harness-session-id`；普通 agent、标题生成与压缩请求由 agent loop 提供当前持久化 `Session.id`。

插件在凭据解析成功后惰性获取用户 id，并在该插件实例内缓存。缺少凭据不会创建 `.anonymous-user-id`；即使设置了 `DSH_TELEMETRY_DISABLED`，首个已授权的提供方请求仍可能创建它。直连适配器构造函数接收 `resolveUserId` 依赖，使线路行为可在单元测试中保持确定性。

两个头部都是发送到解析后 `baseURL` 的模型不可见 HTTP 元数据。身份值不在 JSON 请求体中，也不会成为模型可见输入或会话事件。配置的网关会收到它们。提供方特定正文扩展由 [DeepSeek LLM API 扩展决策](../architecture/2026-08-21-deepseek-llm-api-request-extensions.zh.md)单独拥有。遥测共享只控制遥测导出，不会禁用提供方请求身份。

## 验证

- mock 提供方断言已授权请求携带 `getOrCreateAnonymousUserId()` 返回的同一用户 id，并在未提供会话 id 时省略会话头部。
- 会话身份线路测试断言两个头部都存在，并原样保留传入的会话 id。
- 直连适配器测试断言每条 stream 仅解析一次用户 id，keyless 配置测试则证明凭据失败不会创建 `.anonymous-user-id`。
- 真实 Loader 组合测试断言组装后的插件使用共享 user-id 包，而非测试专用值。
- 无需修改 keyless snapshot，因为这些头部不是模型可见或用户可见的 transcript 内容。

## 考虑过的替代方案

| 已否决 | 原因 |
|---|---|
| 把 id 加进通用 `attributionHeaders()` | 该辅助函数是提供方无关且静态的；加入逐用户值会把它发送给无关提供方，并违反其应用身份隐私契约 |
| 在 `cordis.yml` 中配置固定自定义头部 | 部署配置无法推导当前会话 id，且会把稳定身份暴露为可变配置，而不是使用其所属运行时契约 |
| 生成 DeepSeek 专用用户 id | 提供方请求将无法与同一 harness home 的遥测和反馈关联 |
| 随遥测共享关闭该头部 | 提供方请求身份与遥测导出的接收方和目的不同；共用开关会掩盖真实隐私边界 |
| 把 id 放进 OpenAI 兼容的 `user` 或 `metadata` 请求字段 | body 字段可能影响提供方 schema、日志、缓存、token 化或模型可见重建；HTTP 元数据可保留预期边界 |

## 后果

- DeepSeek 支持可以通过一个匿名 harness-home id 跨会话关联请求，并通过持久化 session id 关联同一对话。
- 首个已授权 DeepSeek 请求可独立于遥测导出创建 `$DSH_HOME/.anonymous-user-id`。
- 自定义 DeepSeek 网关会收到稳定用户 id 与可用的会话 id，因此运维方必须将配置的 `baseURL` 视为身份接收方。
- 身份头部不会改变请求体、提示词、token 数、KV cache 身份或会话日志；单独注册的 DeepSeek 正文扩展保留各自约定。
