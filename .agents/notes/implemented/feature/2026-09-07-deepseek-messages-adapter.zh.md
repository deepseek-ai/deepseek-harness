# Agent Note: 通过 Anthropic Messages 协议调用 DeepSeek

Status: implemented

[English](2026-09-07-deepseek-messages-adapter.md) | 中文

## 问题

部署可以通过 Anthropic Messages 网关或 chat-completions 调用 DeepSeek。Messages 对思考、签名、工具调用、工具结果和累计用量的表示不同。仅替换端点或压平助手历史会丢失后续工具轮次需要的信息。

## 决策

[DeepSeek 适配器](../../../../packages/llm/llm-deepseek/README.zh.md)通过一个 `deepseek-official` 路由和 `llm-deepseek` 设置命名空间支持多个协议。`common/` 共享配置、模型目录、能力解析和 Files 生命周期；`protocols/chat-completions/` 与 `protocols/messages/` 分别负责协议序列化、流转换和传输。`protocol` 配置在 Cordis YAML 中选择实现，默认 `messages`；随产品交付的官方组合继承该默认值。已有 `PreparedAdapterCall` 冻结协议、端点、凭据引用与模型能力，重试保持同一代配置，后续调用读取新配置。

适配器遵循 [DeepSeek 兼容文档](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) 和 [Anthropic 流协议](https://platform.claude.com/docs/en/build-with-claude/streaming)。pi-ai 的 Anthropic 实现为相邻用户消息、累计用量、工具参数分片和可选思考签名的处理提供参考。DeepSeek 通过 `output_config.effort` 设置思考强度；Anthropic 思考 token 预算不控制 DeepSeek 思考强度。两种协议都转发显式 `temperature` 值；DeepSeek 在启用思考时接受该参数但忽略其值，因此调用方可以保留已有思考配置。

助手内容块保留持久化的模型可见内容。带版本的 `ReplayEnvelope` 仅保存协议格式、模型标识、对齐的块类型以及内容块未包含的签名。同模型续接原样恢复签名，包括空签名；外部历史不生成虚构签名。不可用的元数据遵循现有[回放降级规则](../architecture/2026-07-14-provider-routed-llm-adapters.zh.md)：请求省略签名并记录警告，保留持久化内容；工具参数等内容校验仍会正常报错。提供者回放数据对循环保持不透明，同时能够随 Session 持久化和内容块裁剪保留。

两种协议均优先为确定性请求图片使用 Files 引用，并共享上传缓存、刷新、配额恢复和附件卸载。Files 客户端保留所选协议与已配置端点：Messages 使用 `/v1/files` 并携带必需的 beta 标头，Chat Completions 使用 `/files`。缓存 id 仍按配置的端点和凭据限定作用域。Messages 元数据不含过期时间，因此本地复用从原始上传时间起受限，但不宣称远端文件已删除。Files 解析失败会按独立的内联图片预算重建完整请求；调用方取消则停止请求。共享图片策略在请求与 token 计量中保留 128 MiB 的保留图片预算、20 MiB 的内联 base64 预算，以及最旧前缀卸载。

系统提示词更新在端点与模型显式声明支持时，使用现有[路由能力](2026-09-02-in-history-system-prompt-replacement.zh.md)。Messages 保留初始顶层 system，在对应的用户或工具结果轮次之后，将后续快照发送为原生 system 轮次，保留此前发送的前缀。这个位置不同于循环先 system、后 user 的接纳顺序；序列化既不改写持久化日志，也不改变对话轮次的顺序。未声明能力的路由将最新快照归并到顶层，直接压缩调用也如此。仅凭协议或模型名称推断能力并不充分，因为支持情况和更新语义取决于实际部署的端点。

Web 始终显示 DeepSeek，不提供协议选择器。两个协议共用 `baseURL` 与 `apiKeyEnv`，没有嵌套的协议配置表。未提供地址覆盖时使用当前协议的官方默认值；Messages 为 `https://api.deepseek.com/anthropic`。切换协议保留已有端点覆盖，部署者负责其兼容性。模型目录只维护一份，包含 `deepseek-flash` 的文本/图片和历史内 system 更新能力，也保留 V4 条目。显式 `chat-completions` 仍受支持，并使用自己的官方默认值；不会为匹配协议而改写自定义 `baseURL` 或环境覆盖。

两种传输都在原生序列化后使用现有[请求扩展注册表](../architecture/2026-08-21-deepseek-llm-api-request-extensions.zh.md)，并在 HTTP 2xx 后、读取流之前接受已捕获贡献。会话日志投递和插件清单仍由原有包负责，并留在模型输入之外。辅助 [web 搜索提供方](../../../../packages/web/web-search-deepseek/README.zh.md)保留独立的端点、请求与设置。

## 考虑过的替代方案

**每个协议独立插件。** 这会重复凭据配置、模型目录、设置卡片和 provider ID，并迫使用户在底层协议变化时重选模型。单插件中的协议目录保留实现隔离；Responses 可以增加自己的实现而不改变用户配置结构。

**把新路由委托给 pi-ai 或 Anthropic SDK。** 两者均提供持续维护的协议实现，但所需的直接适配器需要 DeepSeek 专属配置、附件策略、凭证解析和重试所有权。小型流转换器配合持续维护的 SSE 解析器使这些职责保持明确；库实现适配器仍可独立使用。

**持久化完整原生响应，或把思考压平为文本。** 完整响应重复已记录内容，并使截断对齐复杂化。压平会改变下一次模型输入。最小化的对齐回放元数据可以保留缺失的协议信息，无需新增 Session 格式。

**始终重写顶层系统提示词。** 这会丢弃支持该能力的路由上能够保留缓存的原生更新方式。显式选择能力既保留该方式，也为其他端点保留普通替换；将 system 指令转成 user 文本还会失去其优先级。

## 结果

该包负责协议校验、停止原因映射、取消和错误分类，因此协议变化需要维护适配器。不支持的内容和不完整的流会明确报错。现有重试消费者负责重试；现有装配器在输出达到上限时丢弃未完成的工具调用。Messages 默认配置覆盖共享 base、Web 和独立的官方组合。协议变化保留 provider id 与已保存的模型选择，但显式端点覆盖必须支持所选协议。

验证覆盖协议夹具、真实 Loader 组合、逐文件单元覆盖率、[已记录 Session 回放](../../../../snapshots/session/deepseek-messages-replay/snapshot.yml)与[未知回放版本](../../../../snapshots/session/deepseek-messages-degraded-replay/snapshot.yml)，Web Messages Session 回放，以及凭证控制的文本、思考、工具续接、图片和取消请求。真实网关检查证明与已配置网关的兼容性，不能证明与所有 Anthropic 代理兼容。
