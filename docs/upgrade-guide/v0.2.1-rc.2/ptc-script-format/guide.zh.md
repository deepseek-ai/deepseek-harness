---
kind: upgrade-guide
description: "PTC programFormat 新增 Script 语法，消费者通过 retainsState 判断跨调用内存保留。"
---

# 处理 Script 程序与显式状态保留

[English](guide.md) | 中文

## 变更

已发布的 `@deepseek-ai/dsh-ptc-runtime` 服务将 `PtcRuntime.programFormat` 从 `'function-body' | 'repl'` 扩展为包含 `'script'`。对旧联合类型做穷举匹配的外部消费者必须处理新值。`retainsState` 表示提供方是否为 `stateOwner` 保留内存；基类实现返回 `false`，因此自定义保留状态的提供方必须覆盖该 getter。

Node 仍默认使用 `per-call`。显式启用的 `executionMode: vm-script` 接受 Script 语句和顶层 await，`scriptPersistence` 独立选择是否跨调用保留内存。已有 Node 函数体和 REPL 配置仍然有效。

## 迁移

1. 从 `@deepseek-ai/dsh-ptc-runtime` 导入已导出的 `PtcProgramFormat`，不复制其联合类型字面量。更新自定义工具或工作流适配器中的 `programFormat` 分支。使用语句或末尾表达式处理 `'script'`，不使用顶层 `return`；参见 [Node 语法参考](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#use-this-package)。
2. 将通过 `programFormat === 'repl'` 推断内存保留的检查改为读取 `runtime.retainsState`。自定义 `PtcRuntime` 提供方若按所有者保留内存，应覆盖 `retainsState` 并返回 `true`，同时继续实现 `release(owner)`。
3. 使用新的包声明重新构建外部消费者。确认所有支持的格式均可编译，并且持久化控制对 REPL 和 Script 提供方都按 `retainsState` 判断。
