# Agent Note: todo 事件类型归其生产方所有

Status: implemented
Archived: 2026-09-04

[English](2026-07-20-todo-event-ownership.md) | 中文

## 问题

`SessionEventMap` 可通过声明合并扩展，使每个插件都能添加持久记录，而无需让核心会话包依赖所有事件生产方。`todo/write` 及其 `TodoItem` payload 由 todo 领域生产和解释；核心会话只提供通用的追加、回放、surface 与不变量扩展机制。在核心中声明 todo 专属类型或关系，会让会话主干拥有一个它既不生产、也无法完整校验的插件词汇。

## 决策

`@deepseek-ai/dsh-tool-todo` 在其仅类型出口中声明 `TodoItem`，并通过 `@deepseek-ai/dsh-session/types` 的声明合并加入 `todo/write`。包根入口和 `/client` 入口重新导出 `TodoItem`，使 host 与浏览器消费方共享同一处声明，而无需加载 todo 插件。

检查 todo 记录的消费方使用仅类型导入，并声明显式包依赖与 TypeScript 项目引用。产出的 JavaScript 不含 todo 导入；组合仅为了搜索、传输或渲染可能含有 `todo/write` 的日志时，无需挂载 todo 工具。

todo 不变量配套插件同时拥有 payload 规则和事件必须位于开放轮次内的关系。核心会话的可合并扩展 switch 对 `todo/write` 走默认分支；todo 配套插件会在追加前拒绝格式错误或位于开放轮次之外的快照。它会单次校验现有会话与新发布的会话，并为后续事件推进逐会话的已提交轮次追踪状态。todo 专属的追加、回放、投影和轮次封闭测试与 todo 包放在一起。面向模型的行为仍由 [`todo_write` 功能决策](../feature/2026-06-29-todo-write-tool.zh.md)负责。

## 验证

聚焦的 todo 工具、不变量、投影、集成和 Loader 组合测试覆盖生产方及其配套插件。session-query 提取与客户端 runtime/connection 测试证明仅类型消费方仍能保留 todo 的语义处理。全工作区类型检查证明声明合并通过显式项目图生效；重新生成的事件、持久化、API 与模块目录记录声明位置和依赖边。

## 曾考虑的替代方案

- **把 payload 类型留在核心中作为共享 UI 词汇**——拒绝：渲染复用并不会让核心成为持久事件的生产方或语义所有方。
- **让每个消费方各自按结构收窄 `todo/write`**——拒绝：重复的 payload 声明会漂移，并绕过可合并扩展的事件表。
- **要求每个消费方都挂载 todo 插件**——拒绝：读取持久记录是类型和数据依赖，并不构成安装面向模型工具的授权。

## 后果

核心会话包不导出 `TodoItem`，也不强制 todo 关系。命名或收窄 `todo/write` 的包声明对 `dsh-tool-todo` 的仅类型依赖；只把未知合并事件作通用处理的消费方无需依赖它。todo 包是事件 payload、客户端类型、运行时校验和开放轮次规则的唯一来源。
