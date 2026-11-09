---
kind: upgrade-guide
description: "TypeScript PTC programs use inspect for visible output and start without a console global."
---

# Explicit output in TypeScript PTC programs

English | [中文](guide.zh.md)

## Change

TypeScript `run_code` programs display selected values through `inspect(...values)`. Function return values and final expressions previously appeared in the result; they are now omitted. Each inspected argument is rendered independently.

The Node runtime starts without a console global by default. Reading `console` raises `ReferenceError`, and `typeof console` returns `"undefined"`. Its `enableConsole: true` configuration exposes `log`, `info`, `warn`, `error` and `debug` through the same inspection function.

CUA screenshots and `read_image` return ordinary `Image` values in TypeScript programs. Their `path` points to an attachment file readable in the execution environment; `width` and `height` describe its stored pixels. Pass selected images to `inspect` alongside explanatory text, including images nested in arrays or objects. Read CUA window IDs from the window object’s `windowId`.

## Migration

1. Update programs that print with console or rely on completion values to explicitly inspect the values they need:

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   inspect(result)
   ```

2. Update CUA bridge callbacks to `text => inspect(text)`. Direct `createCuaApi(dispatch, onText?)` callers supply a dispatcher that returns program Images for screenshots and pass the text callback as the second argument. Call `window.getScreenshot()` and pass its returned Image to `inspect`.
3. For integrations that require console methods, set `enableConsole: true` on the `@deepseek-ai/dsh-ptc-runtime-node` provider row. Direct runtime consumers can set `discardCompletion: true` to select the same explicit-output behavior.
4. Run an updated program and verify that inspected values appear once and its final expression adds no output.

```js
const before = await win.getScreenshot()
await app.pressKey("Tab")
const after = await win.getScreenshot()
inspect("before", { windowId: win.windowId }, before, "after", after)
```
