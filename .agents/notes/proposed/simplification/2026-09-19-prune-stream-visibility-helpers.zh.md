# Agent Note: 精简未使用的流可见性辅助函数

Status: proposed

[English](2026-09-19-prune-stream-visibility-helpers.md) | 中文

## 问题

[紧凑 Assistant 流实现](../../../../packages/llm/llm/src/assistant-stream.ts)导出五个可见性查询：`isVisibleChunk`、`chunkHasVisibleText`、`runFirstVisibleTime`、`assistantStreamHasVisibleContent` 和 `assistantStreamHasVisibleText`。仓库搜索未找到这组函数之外的生产调用方。其余消费方是[单元测试](../../../../packages/llm/llm/tests/assistant-stream.spec.ts)、包文档和[记录读取器决策](../../implemented/architecture/2026-09-06-embedded-stream-record-readers.zh.md)。包根入口和发布的 `./assistant-stream` 入口向外部调用方暴露这些函数；本次搜索无法确定外部使用情况。

保留的首 token 读取器已有 [Session Stats](../../../../packages/session/session-stats/src/projection.ts) 和 [Trajectory](../../../../packages/client/ui-trajectory/src/client/trajectory-assistant-definition.ts) 消费方。它们的计时要求不依赖单独区分空白文本的可见性分类。

## 提案

移除这五个导出的可见性查询及其专用私有辅助函数 `hasNonWhitespace` 和 `blockIsVisible`。这会删除约 77 行源码（含局部文档），无需新增替代机制。保留所有首 token、原始分片、文本拼接和组装读取器，以及累加器和带校验的展开操作。保留直接实现和基于库实现的两个 LLM（大语言模型）适配器及其扩展 API。

移除专门的可见性测试；混合读取器测试只删除过时断言。保留验证首 token 计时、提前退出、原始分片、文本拼接和组装等价性的混合 fixture（测试前置数据）与断言。

记录读取器决策只被部分替代：其分配开销方面的理由和仍被使用的读取器继续有效。实施本提案时，更新该现行说明、[包 README](../../../../packages/llm/llm/README.zh.md) 和 [LLM 子系统页面](../../../../docs/subsystems/llm-streaming.zh.md)及其双语对侧。添加本提案时不删除所属说明，也不修改归档记录。

## 备选方案

**为外部消费方保留完整的读取器组。** 这能保留方便且经过测试的可见性查询，但也会在缺少已确认仓库消费方的情况下保留公共函数和专门测试。明确的外部需求可以成为保留或重新引入它们的理由。

**用流展开替代可见性查询。** 当前没有需要迁移的生产调用方。新增替代实现会继续保留未使用的 API，并引入记录读取器原本避免的分配开销。

## 验收标准

- 源码导出和现行 API 文档中不再包含这五个名称；生产调用方不新增展开操作或替代可见性查询。
- 针对流读取器、Session Stats 和 Trajectory 计时的检查通过；混合测试保留无关断言。
- 类型检查、受影响发布入口的构建和文档检查通过。Session 格式、模型输入、transcript（文本记录）内容和首 token 计时保持不变。

## 风险

这会有意收缩导出的稳定前 API。即使仓库中没有消费方，外部导入仍可能失效。实施前重新核对消费方证据，并明确评估发现的外部需求；不得宣称整个生态均未使用这些函数。
