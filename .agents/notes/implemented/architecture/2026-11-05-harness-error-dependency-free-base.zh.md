# Agent Note: 把 HarnessError 基类放在无依赖的包中

Status: implemented

[English](2026-11-05-harness-error-dependency-free-base.md) | 中文

## 问题

工具注册表只有在抛出值 `instanceof HarnessError` 时，才会在失败结果上记录 `error.name` 与 `error.code`，因此每种预期失败都必须继承这一个共享类；只复制它的 `code` 字段不够。[已归档的结构化错误分类决策](../../archived/architecture/2026-06-11-structured-error-taxonomy.md)把基类放在 `dsh-llm` 中，因为当时 `dsh-llm` 是所有包都已导入的叶子包，放在那里不会增加依赖边。

`dsh-llm` 后来不再是叶子包。`ImageBlock` 引用了 `dsh-attachment` 的 `ImageAttachmentRef`，`dsh-llm` 还依赖 `dsh-typert-protocol`。这两个更底层的包中的类无法继承定义在 `dsh-llm` 里的基类，否则 TypeScript 项目引用会成环，因此 `AttachmentError` 与 `RemoteError` 只能在普通 `Error` 上重复实现 `code` 字段，携带它们的工具失败在持久化时没有结构化身份。

## 决策

`HarnessError` 位于 `@deepseek-ai/dsh-error`（`packages/util/error`）。这个包没有任何依赖，只包含该基类。`dsh-llm` 依赖它，并从自身入口重新导出同一个类，因此现有的 `import { HarnessError } from '@deepseek-ai/dsh-llm'` 继续可用，两种导入路径指向同一个构造函数，`instanceof` 判断保持一致。LLM 专属的失败码以及 `isHarnessError` 等辅助函数仍留在 `dsh-llm`。

当导入方本身不需要 `dsh-llm` 时，新代码从 `dsh-error` 导入 `HarnessError`，这样只需要基类的包不必依赖 LLM 运行时。`dsh-attachment` 等位于 `dsh-llm` 之下的包可以继承该基类而不形成依赖环。

## 考虑过的替代方案

**把基类留在 `dsh-llm`。** 底层包会继续重复实现字段结构，注册表也会继续丢弃它们的 code；如果让注册表按结构识别这类对象，它就会信任任何带字符串 `code` 的对象，包括 Node errno 值。

**在注册表中识别特定类。** 按标记匹配 `RemoteError` 或 `AttachmentError` 会让 `dsh-tools` 依赖每个这样的包，而且每出现一个新的底层错误类都要重复一次。

**把基类移到现有的工具包。** `dsh-util-values` 与 `dsh-brand` 的职责与此无关；独立的包能准确命名职责，也让基类不受它们的依赖与变更历史影响。

**去掉 `dsh-llm` 的重新导出。** 所有现有导入都得一次性修改，却不带来任何行为收益。

## 后果

任何包都可以继承 `HarnessError`，包括 `dsh-llm` 所依赖的包，基类也不再随 LLM 运行时一起变更。代价是多发布一个包，`dsh-llm` 多一条依赖边。同一个类有两种导入路径，两者都受支持，错误处理规则把 `dsh-error` 作为它的归属位置。
