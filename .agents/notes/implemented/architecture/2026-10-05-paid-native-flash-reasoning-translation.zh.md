# Agent Note: 付费原生 Flash 翻译使用独立查询

Status: implemented

[English](2026-10-05-paid-native-flash-reasoning-translation.md) | 中文

## 问题

读者可选择模型翻译并承担额外费用。复用对话请求会继承其历史及生成控制，而路由到任意已配置模型会隐藏翻译的计费及接收方选择。

## 决策

付费翻译是[默认匿名路径](2026-10-05-anonymous-reasoning-translation.zh.md)的显式替代选项。只有内置 `deepseek-account` 与 `deepseek-official` 所有者处于活动状态、凭据已配置，且目录包含 ID 恰好为 `deepseek-flash` 的模型时才符合条件。显示名称和版本不参与匹配，pi-ai 路由被排除。每个片段执行一次新的纯文本查询，使用简单翻译指令并关闭思考，不携带此前片段或主历史。

原始 Session 在派发前通过实验性记录 `plugin:translator/request` 在可选 `metadata.modelRequest` 中保留精确的模型可见请求，采用[统一的翻译请求记录](2026-10-05-persistent-machine-translation.zh.md)。现有 `appendPluginRecord` 写入器快照其 JSON 载荷并标为可忽略，不替换主历史。只读缓存查找先于原生准入，且不要求 Session 已激活。缓存未命中时使用已激活 Session 的写入器，在派发前刷新；GUI 按需等待正常 Session 激活，保留普通启动与恢复行为。格式迁移以尽力而为的方式保留这些信息性记录。翻译不向原生请求扩展提供主 Session 身份，因此单个片段不能授权上传完整对话日志。Host 在计费前强制要求已配置的付费选择。

## 考虑过的替代方案

**复用对话的模型调用。** 其历史、模型及思考设置与翻译片段无关，Session 日志派送还可能传输超出所选文本的内容。新的原生 Flash 调用使这些选择明确。

**提供所有模型或版本标签。** 这需要额外的接收方及计费决策。稳定的 `deepseek-flash` ID 支持未来版本，同时保留所要求的内置路由限制。

**替换原始 assistant 输出。** 译文通过统一的结果记录单独保留；原始思考仍是主模型历史的来源。

## 后果

付费查询消耗额外的输入和输出 token。GUI 说明未缓存片段的计费。重新展开复用已持久化的成功结果，即使原生凭据或模型配置不可用。失败时不选择其他路由。本地审计保留独立于提供方日志派送，匿名翻译仍为默认选项。
