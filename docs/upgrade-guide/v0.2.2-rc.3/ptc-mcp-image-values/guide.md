---
kind: upgrade-guide
description: "Admitted MCP image blocks carry an attachment reference and reach PTC programs as Image values instead of base64 JSON."
---

# Admitted MCP image blocks become PTC `Image` values

English | [中文](guide.zh.md)

## Change

An MCP tool result keeps its canonical `{ content, structuredContent? }` value. Each image block admitted to durable model context now also carries an `attachment` reference beside its original `type`, `mimeType`, and `data` fields. Refused images keep their original fields only.

In PTC mode, each value entry of the form `{ type: 'image', attachment }` whose attachment appears in the finalized tool result becomes an `Image`, the same value that `read_image` and CUA screenshots return. Previously, the program received the base64 image block, so `inspect(result)` printed the base64 data, and the complete result content, text and pictures, was attached automatically as additional model context. Now `inspect` shows the picture, and the result's text and pictures enter the conversation only when the program inspects them, as for native CUA screenshots. When the value does not reference every image of the final result, or the program cannot read an image file, the program receives the raw blocks and the complete result content is still attached automatically, as before. Image blocks that an output policy removed keep their `attachment` field but stay JSON.

This affects PTC programs that read `data` or `mimeType` from an admitted MCP image block or rely on the automatic attachment of its result text, and code that compares MCP tool values with the raw server result.

## Migration

1. In PTC programs, inspect the `Image` and any result text the model needs, or read the image file through `path`:

   ```js
   const result = await tools.mcp__server__screenshot({});
   const image = result.content.find(block => block instanceof Image);
   inspect(image);
   ```

2. Where a program needs the bytes, read `image.path` instead of decoding `data`.
3. In code that compares MCP tool values with the server result, allow the added `attachment` field on admitted image blocks.
4. Run the example with a model route that accepts image input. Confirm that the `run_code` result contains the picture and no base64 text.
