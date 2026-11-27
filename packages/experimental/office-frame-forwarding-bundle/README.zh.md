---
description: "面向 Desktop 的实验性原生 Office 只读预览。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-office-frame-forwarding-bundle

[English](README.md) | 中文

## 概述

“Office 只读预览”预装且默认关闭。在插件页面启用或关闭会像其他可选 bundle 一样即时生效。其插件仅在 Host 运行于 Desktop 内时渲染，因为原生帧传输由 Desktop 持有；在 Web 中沿用现有的 PDF 与表格预览。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在 Desktop 中打开**插件**，点击**实验性插件**旁的**更多**，启用**Office 只读预览**；启用后它也会出现在主列表中。原生 DOCX、XLSX 和 PPTX 预览支持选择、缩放、滚动和演示播放。不支持的格式和不可用的原生渲染沿用现有 PDF 或表格回退，文件访问仍受工作区授权约束。

<a id="understand-the-implementation"></a>
## 理解实现

[`cordis.patch.yml`](cordis.patch.yml) 以所有帧转发消费者 bundle 共用的行 `frame-forwarding` 插入[帧转发](../frame-forwarding/README.zh.md)，使其他已启用的消费者运行在同一个实例上，然后以行 `office-preview` 插入 [Office 预览](../client-ui-office-frame-forwarding/README.zh.md)。此 bundle 不提供任何 Electron 主进程代码或 preload：[Desktop 应用](../../../apps/desktop/README.zh.md)持有通用的共享纹理 API 及其跳转与 ingress addon、`dshDesktop.textures` preload 桥接以及 Desktop Host 的 `sharedTexture` 服务；帧转发包持有在 Desktop Host 进程中运行的原生接收器及其 renderer 侧视图；Office 预览消费两者。Office Host 插件向其 Client 报告 `availability`，Client 仅在 Desktop 文档中、且 Host 通过帧转发本地渲染此工作区时才注册原生预览。bundle 的包名不带 `experimental` 前缀，因此能力移出实验分组时，启用它的 profile 保留其引用；依赖隔离和晋升仍由实验性分类约束。

<a id="model-experience"></a>
## 模型体验

无，此 bundle 提供文档预览 UI，不增加模型上下文或 Session 事件。

#### KV Cache 影响

无。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 原生预览支持既有 macOS 和 Windows 目标。Office 编辑、保存和恢复不属于此 bundle 的预览能力。
- Office Host 插件启动的 producer 必须使用此 bundle 的帧转发包所携带接收器的帧转发协议版本和握手能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
