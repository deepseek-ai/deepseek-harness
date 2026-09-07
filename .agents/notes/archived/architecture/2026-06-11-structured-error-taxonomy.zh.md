# Agent Note: 结构化错误分类体系

Status: implemented
Archived: 2026-09-04

[English](2026-06-11-structured-error-taxonomy.md) | 中文

## 问题

故障跨越 seam 时只是裸字符串。工具错误被扁平化为一个文本块（name、code 和 stack 全部丢失），导致未来的沙箱/重试插件无法区分 ENOENT 和 EACCES，模型也未能获得本可提供的更具可操作性的反馈。非 Error 的 throw 退化更严重：agent loop（智能体循环）将其包装为 `new Error(String(x))`，丢弃了所有 code。而 `LlmError` 是系统中唯一的类型化错误，没有共享基类，消费方无法对其进行通用的 `instanceof` 判断。

## 决策

在 `dsh-llm`（叶子包，所有其他包都已依赖它，不引入新的依赖边）中引入一个 `HarnessError extends Error` 基类：稳定的 `code`（与 `message` 分离）、通过 `ErrorOptions` 进行 `cause` 链接、`name` 默认为子类名。`isHarnessError` 在 seam 处做类型收窄。

- `LlmError` 和 `ToolArgsError`（dsh-tools）继承该基类，保留各自既有的 code。
- `ToolExecutionResult` 新增可选字段 `error: { name, code }`，在注册表的 catch 中当抛出值为 `HarnessError` 时填充。agent loop 将其转发到 `tool/result` 会话事件（该事件也新增了同一可选字段），使结构化的失败信息保留在日志中，供重试/沙箱插件和回放使用。面向模型的文本块保持不变。
- agent loop 的 `toError` 将非 Error 的 throw 包装为 `HarnessError`（`code: 'UNKNOWN'`，原始值作为 `cause` 链接），而非裸 `Error`；这样即使是不规范的 throw 也能携带可路由的 code 进入会话的 `error` 事件（该事件此前已暴露 `code`）。

## 后果

- 错误端到端可机器路由：插件可以基于 `error.code` 分支，而无需对消息做子串匹配。
- 一个基类被广泛导入，但它位于所有包已经依赖的包中，代价仅是一条 import 语句，而非新的依赖边。
- `deriveMessages` 不会将 `error` 暴露到模型历史中——模型仍然看到文本块；结构化字段服务于代码和回放。
- 参数校验保留其既有的 code 和行为；包自有的诊断不变式独立携带稳定 code，使不变式注册表无需导入产品包。共享基类增加了跨 seam 的路由元数据，不改变面向模型的文本。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
