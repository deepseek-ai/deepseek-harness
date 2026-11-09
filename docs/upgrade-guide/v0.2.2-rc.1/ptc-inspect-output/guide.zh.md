---
kind: upgrade-guide
description: "TypeScript PTC 程序通过 Harness.inspect 展示输出，并默认不提供 console 全局变量。"
---

# TypeScript PTC 程序的显式输出

[English](guide.md) | 中文

## 变更

TypeScript `run_code` 程序通过 `Harness.inspect(...values)` 展示选定的值。此前函数返回值和末尾表达式的值会进入结果，现在会被省略。各个 inspect 参数独立渲染。

Node 运行时默认启动时没有 console 全局变量。读取 `console` 会抛出 `ReferenceError`，`typeof console` 返回 `"undefined"`。设置 `enableConsole: true` 后，`log`、`info`、`warn`、`error` 与 `debug` 通过同一 inspection 函数输出。

## 迁移

1. 将使用 console 输出或依赖完成值的程序，改为显式 inspect 所需的值：

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   Harness.inspect(result)
   ```

2. 将 CUA 桥接回调更新为 `text => Harness.inspect(text)`。
3. 对于需要 console 方法的集成，在 `@deepseek-ai/dsh-ptc-runtime-node` 提供方配置行中设置 `enableConsole: true`。直接调用运行时的消费方可设置 `discardCompletion: true`，选择相同的显式输出行为。
4. 运行更新后的程序，确认 inspect 的值只出现一次，且末尾表达式不额外输出。
