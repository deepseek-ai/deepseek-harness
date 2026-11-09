---
kind: upgrade-guide
description: "TypeScript PTC 程序通过 inspect 展示输出，并默认不提供 console 全局变量。"
---

# TypeScript PTC 程序的显式输出

[English](guide.md) | 中文

## 变更

TypeScript `run_code` 程序通过 `inspect(...values)` 展示选定的值。此前函数返回值和末尾表达式的值会进入结果，现在会被省略。各个 inspect 参数独立渲染。

Node 运行时默认启动时没有 console 全局变量。读取 `console` 会抛出 `ReferenceError`，`typeof console` 返回 `"undefined"`。设置 `enableConsole: true` 后，`log`、`info`、`warn`、`error` 与 `debug` 通过同一 inspection 函数输出。

CUA 截图与 `read_image` 在 TypeScript 程序中返回普通 `Image`，其 `path` 指向执行环境可读取的附件文件，`width` 与 `height` 为该文件的像素尺寸。使用 `inspect` 将选中的图片与说明一起展示；图片可嵌入数组或对象。CUA 窗口 ID 从窗口对象的 `windowId` 读取。

## 迁移

1. 将使用 console 输出或依赖完成值的程序，改为显式 inspect 所需的值：

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   inspect(result)
   ```

2. 将 CUA 桥接回调更新为 `text => inspect(text)`。
3. 对于需要 console 方法的集成，在 `@deepseek-ai/dsh-ptc-runtime-node` 提供方配置行中设置 `enableConsole: true`。直接调用运行时的消费方可设置 `discardCompletion: true`，选择相同的显式输出行为。
4. 运行更新后的程序，确认 inspect 的值只出现一次，且末尾表达式不额外输出。

```js
const before = await win.getScreenshot()
await app.pressKey("Tab")
const after = await win.getScreenshot()
inspect("before", { windowId: win.windowId }, before, "after", after)
```
