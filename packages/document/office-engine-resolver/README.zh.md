---
description: "从消费方的安装位置解析 LibreOffice Kit 引擎清单，包括原生引擎的 ASAR 路径。"
kind: "package-library"
---

# @deepseek-ai/dsh-office-engine-resolver

[English](README.md) | 中文

## 概述

为应用实际使用的 LibreOffice Kit 安装解析引擎包。ASAR 归档内的原生引擎解析为相邻的解包路径；WASM 保留逻辑路径。[Office-to-PDF 提供方](../office-to-pdf/README.zh.md)使用此回调，无需安装模块钩子或加载 Electron。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此库作为提供 Kit `resolveEnginePackage` 选项的 Node 消费方的依赖。消费方负责声明自己的 Kit 依赖；此包不依赖 Kit，也没有 `cordis.yml` 配置。

```ts
import { createEnginePackageResolver } from '@deepseek-ai/dsh-office-engine-resolver'

const options = {
  resolveEnginePackage: createEnginePackageResolver(import.meta.resolve('@deepseek-ai/libreoffice-kit')),
}
```

将 `options` 传给 Kit 的 `createConverter` 或 `discoverRuntime`，或作为编辑器 `openDocument` 请求的 `options` 字段。在消费模块中解析 Kit 入口：以此库为起点可能选中不同的安装。工厂也接受绝对入口路径或文件 `URL`；每个回调持有独立的解析器。

回调成功时返回引擎 `package.json` 的绝对路径。包不存在时保留 Node 原始的 `MODULE_NOT_FOUND`，允许 Kit 从原生引擎回退到 WASM。如果包目录存在（包括断开的符号链接），但清单无法解析，回调抛出安装不完整错误，并将 Node 错误保存在 `cause` 中；此时应重新安装该包。其他解析错误和文件系统检查错误原样传播。Kit 负责验证返回的清单和必需资源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[工厂](src/index.ts)从传入的 Kit 入口创建 Node 解析器，并相对该入口解析引擎清单。原生路径只将第一个 `.asar` 归档段替换为 `.asar.unpacked`，不论进程是否运行在 Electron 中。已解包路径及归档外路径保持不变。`@deepseek-ai/libreoffice-kit-wasm` 始终保留 Node 逻辑路径，供支持归档的文件系统访问。

回调只解析路径并检查失败的安装。它不加载引擎代码、不注册服务、不修改模块解析，也不保留模块级状态。[Desktop 打包](../../../apps/desktop/packaging/README.zh.md#runtime-file-selection)负责解包文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Office-to-PDF 提供方](../office-to-pdf/README.zh.md) — 转换器配置和请求所有权。
- [文档转换](../../../docs/subsystems/office-to-pdf.zh.md) — 共享宿主转换操作。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此包只解析引擎清单，不构造模型输入或注册工具。

#### KV Cache 影响

无；解析不会构造或修改模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 调用方必须提供其实际使用的 Kit 安装入口；解析器不发现或安装 Kit 或引擎。
- 映射原生路径不验证解包副本是否存在。Kit 会拒绝缺失的清单或资源，而不是将其视为原生包未安装。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
