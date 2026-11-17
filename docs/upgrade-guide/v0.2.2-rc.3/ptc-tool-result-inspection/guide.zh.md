---
kind: upgrade-guide
description: "直接展示未修改的 PTC 工具对象和数组结果时使用工具渲染文本，自定义 Node bootstrap 须升级到协议 5。"
---

# PTC 工具结果展示与 bootstrap 协议 5

[English](guide.md) | 中文

## 变更

PTC 工具保留声明的 JSON 返回值。无论是否附带展示元数据，字段访问、拷贝和 JSON 序列化都操作原有数据；只供宿主使用的描述符不会暴露给程序。此前，`inspect(result)` 使用 Node 的通用对象格式展示对象或数组。现在，原结果未被修改且其输出仅包含文本时，会展示工具最终渲染的文本。该文本包含已完成的输出策略修改；展示不会重新运行工具或再次调用 `output.render`。仅针对日志的替换不影响此文本。

非空的关联文本独占一个输出组。执行 `inspect('result:', result, 'done')` 时，先输出标签并换行，再输出工具文本，随后另起一组输出 `done`。同组普通值仍以空格分隔。

字段选择、拷贝、修改后的结果，以及嵌套在其他值中的结果，仍使用通用格式。标量结果、Image 和混合文本与图片的输出保持原有行为。依赖完整工具结果展示文本的程序和检查会受到影响。可展示的容器可以保留 Image 字段：直接展示容器时输出附带文本；单独展示图片字段时输出该图片。

Node bootstrap 协议从 3 升至 5。`HostMethods.invoke` 的回复现在使用 `{ value: flatWire, inspection?: string }`。自定义 `launch.bootstrapPath` 部署必须更新 bootstrap；内置 bootstrap 随宿主一同更新。

## 迁移

1. 保留 `inspect(result)` 可展示工具渲染的文本。如需展示对象结构，改为展示拷贝或选定字段：

   ```js
   const result = await tools.read({ file_path: "README.md" });
   inspect(result);
   inspect({ ...result });
   inspect(result.lines);
   ```

2. 对数组结果，使用 `inspect([...result])` 以通用格式展示元素。更新依赖此前完整结果对象格式的预期输出。
3. 如果实现了第三方 `PtcRuntime`，请识别绑定返回的 `@deepseek-ai/dsh-ptc-runtime` 包中的 `PtcInspectableValue`。将 `.value` 作为程序的对象或数组，并为该未修改的原值关联 `.text`，供直接 `inspect` 使用。不要暴露包装对象，也不要向程序字段添加展示元数据。
4. 如果配置了 `launch.bootstrapPath`，请在执行环境中部署匹配版本的 `@deepseek-ai/dsh-ptc-runtime-node` bootstrap 及其依赖。使用包内构建产物 `lib/process.js`，或默认采用 REPL 的 `lib/persistent-process.js`。自定义协议实现必须处理新的回复信封和[输出抑制](../ptc-output-limit/guide.zh.md)，并声明协议 5；只改版本号并不足够。
5. 运行上面的示例。确认第一次展示工具渲染的文件文本，后两次分别展示对象和数组数据。对于自定义提供方，还须确认字段访问和 `JSON.stringify(result)` 使用原有数据。对于自定义 bootstrap，确认 PTC 程序启动时不再报告协议不匹配。
