# Agent Note: LLM 流的终止失败

Status: implemented

[English](2026-07-29-terminal-llm-stream-failures.md) | 中文

本说明取代[有界 LLM（大语言模型）请求恢复](2026-06-21-bounded-llm-request-recovery.zh.md)中的抛出错误身份和调用局部 sidecar 机制；该说明仍负责结构化失败事实、重试策略与持久尝试。[压缩（compaction）参考](../../../../packages/compaction/compaction-basic/README.zh.md)定义当前溢出恢复。

## Problem

适配器失败曾有两种公共表示：选择、分发、iterator 构造或迭代抛出的异常，以及带内的 `finish { kind: 'error' | 'aborted' }`。`LlmRuntime` 会在以流为键的 sidecar 中标记抛出对象，使 agent loop（智能体循环）能将其与 middleware 和消费方失败区分开。消费方仍需用 catch 包围迭代、signal 检查、分片日志记录和组装；正确性因此取决于证明是哪条语句抛错，并查询附着于所返回的那个 iterable 的元数据。

重试策略也采用同样的间接归属。尽管 `prepareCall()` 已捕获服务注册，策略仍要在分发后通过流 sidecar 查找。因此，由包装层提供服务的路由与由适配器提供服务的路由共用一个不透明查询 API，尽管两者的权威不同。

## Decision

`LlmRuntime` 是一次适配器尝试的规范化边界。它只捕获最终适配器选择、同步分发、iterator 构造与 `next()` 失败，将抛出值转换为不可变 `LlmFailure`，并发出一个终止 `finish`。调用方取消或 `ABORTED` 失败选择 aborted 结束原因；其他适配器失败选择 error 结束原因。适配器也可以直接发出任一终止原因。

适配器所属的 catch 会在每个分片被 yield 前结束。来自 `llm/stream` middleware、嵌套调用、适配器清理、分片消费方、日志记录、signal 检查与组装的错误仍作为缺陷或生命周期失败抛出；它们绝不进入模型请求恢复。部分 delta 之后的传输失败可能在结束原因为 error 或 aborted 的终止 finish 之前留下未关闭块。不会从这些不完整输出组装 assistant 消息或工具调用。

`PreparedLlmCall` 公开随其配置和注册捕获的不可变重试策略。一次性句柄复用与配置不匹配仍是同步的 `INVALID_PREPARED_CALL` 误用错误。完全由 `llm/stream` middleware 提供服务的路由没有准备完成的注册，因此也没有服务策略。

agent loop 只消费一种失败表示。它不再使用分类 catch，而是直接迭代并记录分片、检查终止 finish，再把其中的失败事实与准备完成的策略传给 `agent/request-error`。公共的 `isLlmAdapterFailure`、`llmFailureOf` 和 `llmRetryPolicyOf` sidecar API 不再存在。

## Alternatives considered

**保留调用局部错误标记。** 这会保留抛出对象身份，但要求每个消费方用 catch 包围一段包含自身易失败工作的区域，并让分类依赖 iterable 包装层的身份。原始错误对象无法在恢复中发挥持久作用；规范化事实才是有用的边界值。

**要求所有适配器发出失败分片，并禁止抛出。** 库 iterator、transport 与 JavaScript 分发仍可能抛错。要求每个适配器复制同一 catch 边界会造成职责重复，也无法保护 `LlmRuntime` 的直接消费方免受不完整实现影响。

**在 agent loop 中捕获所有迭代错误。** 如果不重新建立从流对象到创建该对象的适配器调用的 sidecar 映射，loop 无法可靠区分提供方失败与 middleware、会话追加、取消或组装失败。分类应由发起适配器调用的位置负责。

**在流式输出前返回 `Result`。** 流前结果无法表示部分输出之后的传输失败，除非增加第二套响应生命周期。现有终止分片已能表示早期和后期尝试结果。

## Consequences

所有 `LlmRuntime.stream()` 消费方都通过一种带类型的终止协议接收适配器运行失败，而编程与生命周期失败保留普通异常语义。恢复放弃精确抛出对象身份，只暴露与原对象分离的提供方无关事实。流服务承担略多的适配器处理工作，但消费方删除了用于判断哪个适配器抛出异常的 catch，也删除了以流为键的元数据。准备完成的调用显式携带策略，而完全由 middleware 提供服务的路由仍明确没有策略。
