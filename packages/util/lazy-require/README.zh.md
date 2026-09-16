---
description: "按调用方解析并惰性加载 CommonJS 兼容的 Host 依赖，使应用启动时不初始化尚未使用的依赖。"
kind: "package-library"
---

# @deepseek-ai/dsh-lazy-require

[English](README.md) | 中文

## 概述

`dsh-lazy-require` 会让 CommonJS 兼容的 Host 依赖保持未加载状态，直到首次实际操作。解析仍以消费方 package 为基准，同一进程 realm 会复用一次成功加载的模块值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

传入依赖的字面量 specifier 与调用方的 `import.meta.url`：

```ts
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

interface NativeModule { open(): void }
const requireNative = createLazyRequire<NativeModule>('native-package', import.meta.url)
```

调用 `requireNative()` 时才加载依赖，并只加载一次。失败的加载不会被缓存。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本工具使用传入的调用方 URL 创建 Node `require`，并且只缓存成功返回的值。显式调用方 URL 会在发布后保留 package 局部的依赖解析。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 按调用方解析的 loader 与成功结果缓存 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包地图](../README.zh.md)——相邻的共享原语。
- [NPM 发布序列](../../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md)——发布依赖分类与首次使用加载策略。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本 Host 工具不注册任何模型可见行为。

#### KV Cache 影响

无。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限兼容 CommonJS 的依赖**——仅 ESM package 需要由调用方拥有异步 factory。
- **WebWorker 打包需要显式请求**——静态 packer 无法发现仅在 `createLazyRequire()` 调用中命名的依赖。Preview image 使用的 package 必须通过受支持的字面量请求保持该依赖可达，直到 packer 能够识别此 helper。

本包不发布运行时 invariant companion，因为 loader 不持有可独立观测的可变关系。

<a id="dev-note"></a>
### 开发备注

无。
