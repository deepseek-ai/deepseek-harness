---
kind: upgrade-guide
description: "Direct inspection of unchanged PTC object and array tool results uses tool-rendered text, and custom Node bootstraps require protocol 5."
---

# PTC tool-result inspection and bootstrap protocol 5

English | [中文](guide.zh.md)

## Change

PTC tools keep their declared JSON return values. With or without inspection metadata, field access, copying, and JSON serialization operate on the original data; the host-only descriptor is not exposed to the program. Previously, `inspect(result)` formatted an object or array with Node's generic object formatter. It now displays the tool's final rendered text when the original result is unchanged and its output contains only text. The text includes completed output-policy changes; inspection neither reruns the tool nor calls `output.render` again. Log-only replacements do not affect it.

Non-empty associated text occupies a separate output group. `inspect('result:', result, 'done')` emits the label and a newline, then the tool text, followed by `done` in another group. Ordinary values in one group remain space-separated.

Field selections, copies, modified results, and results nested inside another value still use generic formatting. Scalar results, Images, and mixed text/image outputs keep their behavior. This affects programs and checks that depend on the exact text produced by inspecting a complete tool result. Inspectable containers may retain Image fields: direct inspection shows the supplied text; inspect the image field separately to display it.

The Node bootstrap protocol changes from 3 to 5. `HostMethods.invoke` replies now use `{ value: flatWire, inspection?: string }`. Custom `launch.bootstrapPath` deployments must update their bootstrap; the bundled bootstrap updates with the host.

## Migration

1. Keep `inspect(result)` to display the tool's rendered text. To display an object's structure, inspect a copy or selected fields:

   ```js
   const result = await tools.read({ file_path: "README.md" });
   inspect(result);
   inspect({ ...result });
   inspect(result.lines);
   ```

2. For an array result, use `inspect([...result])` to display its elements with generic formatting. Update any expected output that relied on the previous full-result object formatting.
3. If you implement a third-party `PtcRuntime`, recognize `PtcInspectableValue` binding results from `@deepseek-ai/dsh-ptc-runtime`. Deliver `.value` as the program's object or array, and associate `.text` with that unchanged value for direct `inspect`. Do not expose the wrapper or add inspection metadata to program fields.
4. If you configure `launch.bootstrapPath`, deploy the matching `@deepseek-ai/dsh-ptc-runtime-node` bootstrap and its dependencies in that execution environment. Use the package's built `lib/process.js`, or `lib/persistent-process.js` for a REPL default. A custom protocol implementation must handle the new reply envelope and [output suppression](../ptc-output-limit/guide.md), and announce protocol 5; changing the version alone is insufficient.
5. Run the example above. Confirm that the first inspection shows the tool's rendered file text, while the other two show object and array data. For a custom provider, also confirm that field access and `JSON.stringify(result)` use the original data. For a custom bootstrap, confirm that a PTC program starts without a protocol-mismatch error.
