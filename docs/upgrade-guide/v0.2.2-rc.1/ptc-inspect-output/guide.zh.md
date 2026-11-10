---
kind: upgrade-guide
description: "TypeScript PTC 程序通过 inspect 展示选定的值，并返回有序的文本与图片输出。"
---

# TypeScript PTC 程序的显式输出

[English](guide.md) | 中文

## 变更

TypeScript `run_code` 程序通过 `inspect(...values)` 展示选定的值。此前函数返回值和末尾表达式的值会进入结果，现在会被省略。各个 inspect 参数独立渲染：字符串直接展示，其他值使用 Node 的对象格式，不限制预览深度、数组项数或字符串长度。undefined 属性、Error 对象和循环引用均会展示。

只有 CUA 截图与 `read_image` 在 TypeScript 程序中返回普通 `Image`，其 `path` 指向执行环境可读取的附件文件，`width` 与 `height` 为该文件的像素尺寸。使用 `inspect` 将选中的图片与说明一起展示；图片可嵌入数组、Map 条目、Set 的值以及可枚举的对象属性。嵌套图片的选择遵循 Node 的自定义格式化。CUA 窗口 ID 从窗口对象的 `windowId` 读取。

其他图片工具保留其声明的程序返回值，并将图片自动附加到模型上下文。图片适配要求附件在程序文件系统中有可读路径。`fs-ssh` 未提供这项映射，因此该组合中的 `read_image` 与 CUA 截图绑定会失败。需要程序 Image 时，使用本地文件系统组合。

格式化选定的值所需内存可能大于保留的输出；参见 [Node 格式化的内存限制](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#known-limitations-and-deferred-work)。

## 迁移

1. 将依赖完成值的程序，改为显式 inspect 所需的值：

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   inspect(result)
   ```

2. 将 CUA 桥接回调更新为 `text => inspect(text)`。直接调用 `createCuaApi(dispatch, onText?)` 时，提供截图返回程序 `Image` 的分派器，并将文本回调作为第二个参数。调用 `window.getScreenshot()`，再将返回的 `Image` 传给 `inspect`。

   ```js
   const { connectCua } = await import("<host-provided bridge file URL>")
   const cua = connectCua(() => tools.cua, text => inspect(text))
   const app = await cua.getApp("TextEdit")
   const windows = await app.getWindows({ emit: false })
   const win = await app.getWindow(windows[0].windowId)
   const before = await win.getScreenshot()
   await app.pressKey("Tab")
   const after = await win.getScreenshot()
   inspect("before", { windowId: win.windowId }, before, "after", after)
   ```

3. 直接调用运行时的消费方可设置 `discardCompletion: true`，选择相同的显式输出行为。
4. 第三方 `PtcRuntime` 提供方将返回的 `logs` 数组替换为 `output: PtcOutput[]`；直接消费运行时结果的调用方改为读取 `result.output`。文本条目为 `{ type: 'text', text }`，图片条目为 `{ type: 'image', attachment }`，数组顺序就是展示顺序。保留实际输出的换行，相邻文本条目直接拼接，不额外插入分隔符。
5. 使用自定义 `launch.bootstrapPath` 的部署，请按 [Node PTC bootstrap 升级指南](../ptc-bootstrap-protocol/guide.zh.md)更新。
6. 运行更新后的程序，确认 inspect 的值只出现一次，且末尾表达式不额外输出。
