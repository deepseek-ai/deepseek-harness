---
kind: upgrade-guide
description: "TypeScript PTC programs display selected values through inspect and return ordered text and image output."
---

# Explicit output in TypeScript PTC programs

English | [中文](guide.zh.md)

## Change

TypeScript `run_code` programs display selected values through `inspect(...values)`. Function return values and final expressions previously appeared in the result; they are now omitted. Each inspected argument is rendered independently.

CUA screenshots and `read_image` return ordinary `Image` values in TypeScript programs. Their `path` points to an attachment file readable in the execution environment; `width` and `height` describe its stored pixels. Pass selected images to `inspect` alongside explanatory text, including images nested in arrays or objects. Read CUA window IDs from the window object’s `windowId`.

## Migration

1. Update programs that rely on completion values to explicitly inspect the values they need:

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   inspect(result)
   ```

2. Update CUA bridge callbacks to `text => inspect(text)`. Direct `createCuaApi(dispatch, onText?)` callers supply a dispatcher that returns program Images for screenshots and pass the text callback as the second argument. Call `window.getScreenshot()` and pass its returned Image to `inspect`.

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

3. Direct runtime consumers can set `discardCompletion: true` to select the same explicit-output behavior.
4. Direct runtime consumers read `result.output`: text entries are `{ type: 'text', text }`, image entries are `{ type: 'image', attachment }`, and array order is display order.
5. Run an updated program and verify that inspected values appear once and its final expression adds no output.
