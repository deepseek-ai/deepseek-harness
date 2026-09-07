# Agent Note: 空模型补全是可重试的 EMPTY_RESPONSE 失败

Status: implemented
Archived: 2026-09-04

[English](2026-07-24-empty-model-response-is-retryable.md) | 中文

## 问题

提供方偶尔会返回一种退化的 completion：流本身格式完好，以终止性的 `stop` 结束，却没有任何内容块——没有文本、没有推理（reasoning）、没有工具调用。如果适配器把这种形态映射为成功的 `{kind: 'stop'}` 结束，主循环就会记录一条空的 `assistant/message`，并把该轮次以 `completed` 结束。系统不会重试，失败也不会向调用方暴露，而像 goal-round-driver 这样的驱动方会消耗一个 Round，却没有取得任何进展。

## 决策

由适配器把「已完成但为空」的响应归类为一次提供方边界失败，重试策略则将其视为瞬时性问题：

- `dsh-llm` 在 `CONTEXT_WINDOW_EXCEEDED_CODE`/`QUOTA_EXCEEDED_CODE` 之外，导出规范代码 `EMPTY_RESPONSE_CODE`（`'EMPTY_RESPONSE'`）。
- `dsh-llm-pi-ai`（`mapStopReason`）：当终止性 `stop` 所对应的 assistant 消息没有内容块时，它会变成一个携带该代码的 `finish {kind: 'error'}`。上下文溢出检测在其适用场景中仍然优先（它先被检查，也是更具可操作性的归类）。
- `dsh-llm-deepseek`（`translate`）：在 `[DONE]` 处，若 `stop`（或缺失）结束且没有打开过任何块，则同样变成该错误结束。仅含推理的流算作有内容，仍视为成功。
- 由提供方定义的常规重试默认值包含 `EMPTY_RESPONSE`：这次尝试没有产生任何持久内容，因此重复它是安全的；部署方仍可通过 `retryableCodes` 将其移除，而 `dsh-llm-retry` 会执行解析后的策略。

检测仅限于 `stop` 结束。内容为空的 `max-tokens` 保持其既有含义（pi-ai 已经把零输出的溢出场景归一化处理），`tool-calls` 在实践中不可能是空块，而 error／aborted 结束本身已经算失败。

这套归类使用既有的主循环机制——`finishError` → `agent/request-error` → `dsh-llm-retry`——并让 `agent-loop` 保持提供方无关。重试预算耗尽时，该轮次会以显式的 `EMPTY_RESPONSE` 失败结束，而不是在没有内容的情况下成功结束。

## 考虑过的替代方案

**在主循环或 `BlockAssembler` 中检测。** 只需一份共享实现，但这会把对提供方响应的判断挪进主循环，违背「插件优先，而非改动主循环」，且 assembler 是纯粹的组装算法。适配器才是把协议层面的事实转化为 harness 归类的地方，而溢出重归类正是精确的先例。

**在 `llm/stream` waterfall（瀑布式事件）上做一个流转换插件。** 这种做法提供方无关且只需一份实现，但它为「每个适配器几行就能声明的边界事实」额外增加了一个包和相应接线，而且默认开启的行为仍需改动每一个 bundle。

**把仅含空白或仅含推理的响应也当作空响应。** 作为过度设计予以否决：这类响应携带了模型产生的内容，把一个合法（哪怕无用）的响应误判为传输类失败，会在那些故意在推理之后停止的模型上引发重试循环。其范围严格限定为「零内容块」。

## 后果

- 一个偶发异常的提供方会消耗一次有界重试，而不是一个没有输出的轮次；一个持续返回空内容的模型则会产生用户可据以行动的 `EMPTY_RESPONSE` 轮次失败。
- 一个确实打算什么都不说的模型（罕见，但在一次工具结果之后有可能出现）会被重试，若始终为空，则该轮次失败。这个取舍是经过审慎权衡后接受的：一条空的 assistant 消息与提供方缺陷无法区分，且对用户毫无价值。
- [`empty-response-retry` headless 快照](../../../../snapshots/session/empty-response-retry/)是配有确定性 1 ms 零抖动重试 overlay 的人工无密钥场景。它钉住持久的 `llm/retry` 事件、被丢弃的尝试不产生输出、恢复后的回复，以及一次正常完成的轮次。
