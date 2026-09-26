# Agent Note: 删除 Python SDK 未使用的反向 RPC

Status: proposed

[English](2026-09-19-python-sdk-directional-client.md) | 中文

## 问题

[Python 客户端](../../../../python/sdk/src/deepseek_harness/client.py) 维护入站请求队列、关闭时的唤醒，以及 `next_request`、`respond`、`respond_error` 和 `notify` 方法。[SDK 服务端](../../../../packages/sdk/server/src/server.ts) 接收请求并发送通知，没有定义服务端主动发起的请求或客户端通知处理器。搜索 Python 源码、示例和运行时 profile 后，仅在客户端实现和[合成客户端测试](../../../../python/sdk/tests/test_client.py) 中发现反向通信。因此，导出的 `IncomingRequest` 模型没有受支持运行时的生产方。

这是[定向 JSON-RPC 提案](../../rejected/simplification/2026-07-19-make-jsonrpc-directional.zh.md) 的缩小范围续案；该提案的否决原因明确允许单独重提传输收缩。其完成语义重设计仍被否决。它对共享 TypeScript 传输的判断已不适用：[Codex wire 适配器](../../../../packages/subagent/subagent-codex/src/wire.ts) 在两个方向上都使用请求和通知。

## 提案

从客户端、模型和导出中删除四个 Python 方法、`_requests` 和 `IncomingRequest`。在匹配响应前，保留对同时含有 `id` 和 `method` 的意外帧的显式保护，避免服务端请求完成无关的待处理客户端请求。保持客户端请求、响应校验、入站通知订阅和关闭行为。

删除专门的合成反向请求测试。仅为触发 fixture（测试前置数据）行为而发送客户端通知的测试改用请求和响应，同时保留过滤器异常与并发写入断言。该变更删除一个队列及其生命周期、四个公共方法、一个公共模型和约三十多行源码，不增加替代传输实现。

## 考虑过的替代方案

**保留通用 Python 对等端供外部插件使用。** 自定义运行时可能使用这些方法，但没有 SDK 方法规定其请求所有权、取消或交付协议。提案接受这一稳定前 API 损失；未来双向 SDK 功能必须提供实际的方法与生命周期要求。

**同时收缩共享 TypeScript 传输。** 否决，因为 Codex 适配器是当前双向消费方。共享实现及其测试保留。

## 验收标准

- Python 源码和示例不再包含反向 API 或请求队列；文档和导出描述保留的客户端角色。
- 复用待处理客户端 id 的意外服务端请求不能完成其等待方。通知过滤、同级交付、末尾排空、错误帧处理、串行写入和关闭仍通过现有测试。
- 提交提示仍返回持久化入队回执；不引入单条提示的完成承诺或基于响应的轮次结果。
- 运行 Python 客户端测试、已安装运行时的 SDK 冒烟与快照检查，以及文档和 lint 检查。保留 TypeScript 传输和已发布 Session fixture。

## 风险

使用自定义运行时插件的外部 Python 调用方会失去这些方法。忽略不支持的请求无法满足假想服务端的响应期待；这是有意撤回该方向，而非保持协议等价。如果受支持的服务端主动请求方法先于实现落地，需要重新评估提案。
