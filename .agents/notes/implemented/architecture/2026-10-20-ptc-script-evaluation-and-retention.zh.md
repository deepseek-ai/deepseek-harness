# Agent Note: PTC Script 求值与状态保留

Status: implemented

[English](2026-10-20-ptc-script-evaluation-and-retention.md) | 中文

## 问题

程序语法和内存生命周期回答不同的问题。消费者可能需要 Script 声明和完成值，同时要求全新环境或保留引用。根据 REPL 语法推断内存生命周期会阻碍这种选择。

## 决策

Node 提供方增加 `executionMode: vm-script` 和独立的 `scriptPersistence` 选项，后者默认为 false。`PtcRuntime.programFormat` 描述接受的语法，`retainsState` 描述按所有者保留的内存。消费者通过后者提供持久化控制和指引。已有 `per-call` 和 `persistent-in-memory` 配置保留原有含义与默认值。

本决策扩展[尽力保留 PTC 状态](2026-09-23-best-effort-persistent-ptc.zh.md)中的模式命名决策；其中的所有权、非持久存储及恢复决策仍然有效。Node 提供方一次性选择求值器，并在临时和保留生命周期之间共用受管进程机制。AsyncFunction、REPL 和 Script 仍是独立的求值器实现，进程复用不决定语法。

VM Script 在受管子进程内使用独立 realm。顶层 await 使用 Node.js v26.6.0 REPL 转换，由 Acorn 和 acorn-walk 提供解析与遍历。在原生编译之前检测 await，因为非严格 Script 可以将 `await` 编译为标识符。适配后的 visitor 遍历方法的计算属性名，但不进入方法体。源码保留上游署名和许可；[包参考](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#known-limitations-and-deferred-work)负责声明与 realm 限制。

## 考虑过的替代方案

**用 Script 替换已有模式。** 这会改变现有消费者的异步函数返回语法和 REPL 声明行为。增加模式可在提供 Script 语义的同时保留已有选择。

**在每个模式名称中同时编码语法与保留方式。** 为全新和保留状态的 Script 分别命名，会重复语法选项，并鼓励消费者根据格式推断持久化。一个 Script 模式加显式保留选项，让两项事实可以分别观测。

**仅使用原生 Script，不转换 await。** 原生 Script 无法求值顶层 await。只在原生编译失败后解析，也会漏掉将 `await` 编译为标识符的有效程序。Node 转换提供声明保留和完成值处理，同时明确其已知语义取舍。

**自行维护通用 AST 遍历器。** 局部遍历器重复 acorn-walk 已提供的遍历功能，还必须独立跟踪新增 Acorn 节点。使用维护中的遍历器可以删除这部分实现，只保留与求值相关的局部 visitor。

## 影响

Script 状态是尽力保留的进程内存，遵循与保留 REPL 相同的显式所有者释放和沙箱失效规则。状态不会序列化，也不会通过重新执行旧程序重建。未捕获的回调异常或未处理的 Promise 拒绝会终止 Script 进程；程序必须等待异步工作。

公开格式联合类型现包含 `script`，自定义保留状态的提供方必须报告 `retainsState`。[升级指南](../../../../docs/upgrade-guide/v0.2.1-rc.2/ptc-script-format/guide.zh.md)说明消费者迁移。源码部署需要求值器模块和 Acorn 包，私有进程 bundle 包含这些依赖。
