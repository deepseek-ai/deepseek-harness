---
kind: upgrade-guide
description: "已接受的 MCP 图片块携带附件引用，并以 Image 值而非 base64 JSON 传给 PTC 程序。"
---

# 已接受的 MCP 图片块成为 PTC `Image` 值

[English](guide.md) | 中文

## 变更

MCP 工具结果保留其规范值 `{ content, structuredContent? }`。每个进入持久模型上下文的图片块现在除原有的 `type`、`mimeType` 和 `data` 字段外，还携带 `attachment` 引用。被拒绝的图片仅保留原有字段。

在 PTC 模式下，形如 `{ type: 'image', attachment }` 且其附件出现在最终工具结果中的每个值条目都会变为 `Image`，与 `read_image` 和 CUA 截图返回的值相同。此前，程序收到的是 base64 图片块，因此 `inspect(result)` 输出 base64 数据，包括文本与图片在内的完整结果内容则自动作为额外模型上下文附加。现在 `inspect` 展示图片，且结果的文本与图片仅在程序 inspect 时进入对话，与原生 CUA 截图相同。返回值未引用最终结果中的每张图片，或程序无法读取某个图片文件时，程序接收原始块，完整的结果内容仍与此前一样自动附加。被输出策略移除的图片块保留 `attachment` 字段，但仍为 JSON。

从已接受的 MCP 图片块读取 `data` 或 `mimeType`、或依赖其结果文本自动附加的 PTC 程序，以及将 MCP 工具值与服务器原始结果比较的代码会受到影响。

## 迁移

1. 在 PTC 程序中，inspect `Image` 以及模型需要的结果文本，或通过 `path` 读取图片文件：

   ```js
   const result = await tools.mcp__server__screenshot({});
   const image = result.content.find(block => block instanceof Image);
   inspect(image);
   ```

2. 程序需要字节数据时，读取 `image.path`，不要解码 `data`。
3. 在将 MCP 工具值与服务器结果比较的代码中，允许已接受图片块上新增的 `attachment` 字段。
4. 使用接受图片输入的模型路由运行上面的示例。确认 `run_code` 结果包含图片且不含 base64 文本。
