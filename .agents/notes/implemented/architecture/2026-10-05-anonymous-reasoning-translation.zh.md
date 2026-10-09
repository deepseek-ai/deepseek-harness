# Agent Note: 免登录翻译独立于模型历史

Status: implemented

[English](2026-10-05-anonymous-reasoning-translation.md) | 中文

## 问题

读者需要用指定语言阅读思考内容，同时无需额外模型凭据，也不替换原始 assistant 输出。翻译需要独立于 Agent 执行的所有者，负责外部请求、取消与失败。

## 决策

实验性 translator 负责显式 Google 或 Bing 路由、Provider 语言标签映射及有界网络请求。Service Definition 与两种 Provider 共用一个包，因为当前消费者使用相同操作与生命周期。可选 GUI 消费者负责设置、段落调度、展开组件内缓存及译文展示。其经过身份验证的 Remote 调用 translator；agent loop 与 Session 事件类型保持独立。

配置的默认服务为 Bing。启用 Bundle 允许将展开的思考内容发送给所选服务，插件元数据与设置公开说明接收方。失败时不选择其他 Provider。原文始终可访问；译文不替换持久化 assistant 输出，也不进入模型输入。[可选 Bundle 准入规则](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md) 保证功能在显式选择前保持关闭。

GUI 向标准 `conversation.chat.reasoning.body` Slot 注册翻译包装，并调用官方 `conversation.chat.reasoning.content` Factory 展示原文或译文。默认正文同样是普通注册项；宿主不提供内联 Markdown fallback 或插件操作状态。翻译包装自行维护工具栏，并将自己的本地化 labels 传入 Factory；Factory 在调用者省略 labels 时提供默认文案，并固定紧凑排版。[思考正文的 Slot 与 Factory 设计](2026-10-09-reasoning-content-slot-factory.zh.md)取代本记录的正文组合方式，外部请求与模型历史隔离的决策保持不变。消费者不替换 assistant 渲染器，也不改变 Session projection。只有展开内容才开始翻译。折叠、切换设置或卸载都会中止未完成工作并忽略迟到结果。

## 考虑过的替代方案

**通过对话使用的 LLM Provider 翻译。** 这会增加模型请求，并依赖模型凭据、定价与路由。免登录翻译有独立的可用性，且无需这些凭据。

**重写 Session 或 Provider 流中的思考内容。** 这会改变原始轨迹，并可能影响思考内容回传。展示翻译保留原始模型历史。

**失败后静默尝试另一端点。** 这会在没有显式选择的情况下将潜在私有文本发送给另一个运营方。重试使用同一 Provider；切换 Provider 是用户操作。

## 后果

匿名翻译不增加第三方翻译库或模型 token 消耗。免登录端点不保证开发者可用性。两种服务均通过 POST 请求体发送原文。译文可能改变 Markdown 或代码格式，也不翻译折叠摘要。

translator 按[统一的机器翻译持久化决策](2026-10-05-persistent-machine-translation.zh.md)保留绑定 Session 的结果；无状态调用不记录结果。
