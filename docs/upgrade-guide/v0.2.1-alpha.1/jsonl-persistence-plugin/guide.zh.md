---
kind: upgrade-guide
description: "JSONL 持久化使用插件命名空间导入；直接构造服务类和类类型标注需要改用持久化服务。"
---

# 通过插件挂载 JSONL 持久化

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-persistence-jsonl` 通过命名导出的 `name`、`Config` 和 `apply` 提供函数插件，没有默认导出。默认导入、直接构造、继承、`instanceof` 和类类型标注会受到影响。插件会保留监听器和句柄，直到移除该提供者所触发的消费者卸载完成；根作用域的并发卸载仍不保证顺序。`sessionPersistence` 服务 API、YAML 配置和存储文件保持不变。

## 迁移

1. 将默认导入替换为 `import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'`。现有的 `ctx.plugin(JsonlSessionPersistence, config)` 调用仍然有效；将直接构造改为该挂载调用。动态导入直接使用 `await import(...)` 返回的模块命名空间，不再取其 `.default`。消费者声明 `inject: ['sessionPersistence']` 并访问 `ctx.sessionPersistence`。
2. 服务类型标注使用 `@deepseek-ai/dsh-session-persistence` 的 `SessionPersistence` 类型。将针对具体类的 `instanceof` 检查和子类改为消费该服务；具体 JSONL 类是私有的。
3. 等待插件启动完成，确认能够创建、flush 并重新打开会话。将消费者的异步清理注册到注入 `sessionPersistence` 的作用域中，以便后端卸载时等待它完成。
