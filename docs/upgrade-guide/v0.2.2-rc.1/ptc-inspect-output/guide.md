---
kind: upgrade-guide
description: "TypeScript PTC programs display selected values through inspect and return ordered text and image output."
---

# Explicit output in TypeScript PTC programs

English | [中文](guide.zh.md)

## Change

TypeScript `run_code` programs display selected values through `inspect(...values)`. Function return values and final expressions previously appeared in the result; they are now omitted. Each inspected argument is rendered independently: strings appear directly, and other values use Node's object formatting without depth, array-length or string-length preview limits. Undefined properties, Error objects and circular references remain visible.

CUA observations previously produced output automatically. `getCapabilities()`, `listApps()`, `findApps(query)`, `getState()`, `app.getWindows()` and app or window `getAccessibilityTree()` now return their results to the program. Use `inspect` to display the values you need.

Only CUA screenshots and `read_image` return ordinary `Image` values in TypeScript programs. Their `path` points to an attachment file readable in the execution environment; `width` and `height` describe its stored pixels. Pass selected images to `inspect` alongside explanatory text, including images in arrays, Map entries, Set values and enumerable object properties. Nested image selection follows Node's custom formatting. Read CUA window IDs from the window object’s `windowId`.

Other image-producing tools retain their declared program values and automatically attach their pictures to the model context. Image adaptation requires a readable attachment path in the program filesystem. `fs-ssh` does not provide this mapping, so `read_image` and CUA screenshot bindings fail in that composition. Use a local filesystem composition for program Images.

Formatting selected values can require more memory than the retained output; see the [Node formatting memory limit](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#known-limitations-and-deferred-work).

## Migration

1. Update programs that rely on completion values to explicitly inspect the values they need:

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   inspect(result)
   ```

2. Remove output callbacks from `connectCua` and `createCuaApi`, the `emit` observation option and the unused `disableDiffing` AX option. Pass observations you want to display to `inspect`, for example `inspect(await app.getWindows())`. A custom dispatcher must return a program Image for screenshot operations.

   ```js
   const { connectCua } = await import("<host-provided bridge file URL>")
   const cua = connectCua(() => tools.cua)
   const app = await cua.getApp("TextEdit")
   const windows = await app.getWindows()
   const win = await app.getWindow(windows[0].windowId)
   const before = await win.getScreenshot()
   await app.pressKey("Tab")
   const after = await win.getScreenshot()
   inspect("before", { windowId: win.windowId }, before, "after", after)
   ```

3. Direct runtime consumers can set `discardCompletion: true` to select the same explicit-output behavior.
4. Third-party `PtcRuntime` providers replace returned `logs` arrays with `output: PtcOutput[]`; direct runtime consumers read `result.output`. Text entries are `{ type: 'text', text }`, image entries are `{ type: 'image', attachment }`, and array order is display order. Preserve emitted line breaks and concatenate adjacent text entries without separators.
5. For custom `launch.bootstrapPath` deployments, follow the [Node PTC bootstrap upgrade guide](../ptc-bootstrap-protocol/guide.md).
6. Run an updated program and verify that inspected values appear once and its final expression adds no output.
