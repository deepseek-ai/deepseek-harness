# Agent Note: 让 JSON-RPC 完成结果与传输方向单一化

Status: rejected — session/prompt became an enqueue receipt without status (2026-07-30-followup-enqueue-and-owned-runs); transport narrowing may be re-proposed alone

[English](2026-07-19-make-jsonrpc-directional.md) | 中文

## 问题

JSON-RPC 桥接层把两个端点都建模为对称的对等端，但实际协议具有固定方向。共享传输层（现为 `dsh-sdk-protocol`，由服务端与 TypeScript SDK 客户端共用，后者行使出站请求/入站通知方向）仍实现着没有任何端点使用的两个半边：服务端发起的请求与客户端发起的通知。Python SDK 发送请求并接收响应或通知，却还会把来自服务端、但未使用的入站请求放入队列，并公开响应辅助方法。

`session/prompt` 还会用两种协议结构报告同一个已结束轮次。服务端先发出 `session.finished`，再返回常量 `{ accepted: true }`；Python SDK 丢弃该响应，转而等待通知以取得状态。响应只有在处理函数返回后才会写入，因此在同一条有序流上，通知必然先于这个常量响应。

这些未使用的双向能力引入了待处理请求表、生成 ID、请求队列、关闭时的拒绝路径、响应辅助方法和第二套完成等待逻辑，却没有任何生产调用方使用。

## 提案

按实际角色收窄两个端点。服务端保留入站请求、出站响应和出站通知；TypeScript 与 Python 客户端保留出站请求以及入站响应或通知。删除没有任何端点使用的方向——服务端发起的请求与客户端发起的通知。

在 `agent.whenIdle()` 完成后，由 `session/prompt` 直接返回 `{ status, reason }` 作为轮次结果。删除 `session.finished`、常量接纳响应以及 Python 中响应后的完成等待循环。`session.event` 与 subagent 通知仍在响应前流式发出，持久化会话事件仍是最终响应重建的真源。

## 实施计划

1. 在 `packages/sdk/server/src/server.ts` 中，用 `status: 'ok' | 'error' | 'aborted'` 和捕获的 `TurnEndReason` 替换 `SessionPromptResult.accepted`。`HarnessSdkJsonRpcServer.prompt()` 把 `completed` 映射为 `ok`，把 `aborted` 映射为 `aborted`，把其他当前已有或可通过声明合并扩展的原因映射为 `error`；进入空闲状态却没有 `turn/end` 仍视为不变量错误。只删除 `session.finished`，保持 `session.event`、`subagent.started` 和 `subagent.finished` 不变。
2. 在 `packages/sdk/protocol/src/transport.ts` 中，把共享类收窄到有消费者的方向——入站请求/出站响应（服务端）与出站请求/入站响应及入站通知（TypeScript SDK 客户端）——只删除服务端发起的 `request()` 用法与客户端发起的通知分发，或把该类拆分为服务端与客户端两个传输。请求结果、方法不存在与处理器错误响应保持原有行为，并继续排在被等待处理器发出的通知之后。
3. 在 `python/sdk/src/deepseek_harness/client.py`、`models.py` 和 `__init__.py` 中，删除 `IncomingRequest`、`_requests`、`notify()`、`next_request()`、`respond()` 和 `respond_error()`。新增公开且经过校验的 `SessionPromptResponse` 来携带状态与原因，由 `session_prompt()` 返回该对象，并保留明确的读取保护：忽略意外的服务端请求帧，避免它们命中响应等待器。
4. 在 `python/sdk/src/deepseek_harness/api.py` 中，根据 `SessionPromptResponse` 构造 `TurnResult.status` 和新增的 `TurnResult.reason`，再删除 `session.finished` 分支与第二个完成循环。请求期间保持订阅打开，并保留 `_request_raw()` 最后的通知排空步骤，确保写在响应前的最后一条 `turn/end` 事件与任何 subagent 通知，都会在 `Session.run()` 重建最终助手消息之前被收集。
5. 用按方向的覆盖替换 `packages/sdk/protocol/tests/transport.spec.ts` 中的对称传输对用例，并更新 `server.spec.ts`、`plugin-apply.spec.ts` 和 `built-scope-carrier.e2e.ts`，覆盖直接结果、顺序、重叠、关闭和收窄后的伪实现；同步更新 TypeScript SDK 客户端（`packages/sdk/client`）及其套件以采用基于响应的结束流程。更新 `python/sdk/tests/test_client.py`，覆盖基于响应的结束流程、意外请求帧处理、回调与并发行为，以及已删除的公开辅助方法。同步更新 JSON-RPC README、双语 Python SDK README、导出 JSDoc 与声明、`scripts/smoke-python-runtime.py` 和 Python 单可执行文件快照。

## 备选方案

**为未来方法保留通用的对称 JSON-RPC 对等端。** 服务端发起的请求将来可能用于交互式权限，但没有类型化方法或生产消费方。该功能完成设计后，预发布协议可以增加所需的最小方向，无需提前保留未使用的对等端能力。

**为流式客户端保留 `session.finished`。** 轮次结束不是增量数据：请求响应已经标识同一个边界，并且在有序流中位于先前所有通知之后。第二条终止通知会产生两种结果表示，迫使客户端进行协调。

## 验收标准

- TypeScript 端点无法发起请求，也不消费通知。
- Python 端点无法发起通知，也不消费服务端请求。
- 轮次结束后，`session/prompt` 返回权威的 `ok`、`error` 或 `aborted` 状态及其原因。
- 轮次中发出的会话事件与 subagent 生命周期通知都先于响应到达。
- 同一会话的重叠拒绝、分帧、多字节输入、处理器错误、flush、关闭顺序与最终响应重建保持原有行为。
- TypeScript 桥接测试、Python SDK 测试、构建后 JSON-RPC 覆盖、快照和生成的 API 文档全部通过。

## 风险

本提案会刻意收窄预发布协议格式。仅监听 `session.finished` 的原始客户端，以及使用未使用对称传输方法的嵌入方，都必须改为读取请求响应。未来若需要服务端发起请求，应新增类型化协议，而不是复用休眠的通用机制。
