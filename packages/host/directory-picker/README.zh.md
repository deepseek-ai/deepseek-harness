---
description: "面向 web GUI 宿主的工作区目录选择 seam：原生与浏览后端所实现的服务约定、能力词汇与错误码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker

[English](README.md) | 中文

## 概述

web GUI 宿主通过一份约定让操作者选择工作区目录：一个只提供一个方法的服务，该方法报告所组合后端提供的是哪种交互。后端之间的差异在于交互形态，而不仅仅是机制——原生后端在宿主屏幕上打开一个 OS 选择器，浏览后端则为应用内浏览器提供列举与创建原语，也能服务于远程客户端。消费方按报告的能力类型分支；新后端无需修改本包即可扩展能力词汇。该 seam 只服务 GUI 宿主，绝不进入 agent loop；后端与协议映射就在它旁边。

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

挂载且只挂载一个目录选择后端，然后让工作区流程驱动它：seam 本身只是服务约定，因此没有后端的组合就无从选择目录。

### 选择后端

当操作者坐在宿主屏幕前时，[原生后端](../directory-picker-native/README.zh.md)是正确选择：`directoryPicker/pick` 打开一个 OS 选择器，返回所选绝对路径，取消时返回 `null`。[浏览后端](../directory-picker-browse/README.zh.md)处处可用——它在浏览器中列举一个目录层级并创建子目录，因此无法触达 OS 对话框的远程客户端依然能选择工作区。当宿主处境在两次启动之间变化时，组合[自适应选择器](../directory-picker-auto/README.zh.md)，它在启动时判定一次处境并挂载匹配的后端。

### 能力约定

`capability()` 返回一个可辨识联合类型，说明操作者如何选择目录：OS 选择器为 `{ kind: 'native', pick(signal) }`，应用内浏览器为 `{ kind: 'browse', list(path?), createDirectory(path, name) }`。消费方按 `kind` 分支；某个组合没有实现的能力类型意味着界面隐藏选择入口，而不是失败。浏览失败抛出带类型的 `DirectoryPickerError`，其错误码集合是封闭的——`directory-unreadable`、`directory-exists` 或 `directory-create-failed`——每个都携带出错对象的路径，选目录 Remote controller 将其 1:1 映射为协议错误码。

### 行携带什么

`DirectoryEntry` 行暴露绝对 `path` 与宿主判定的 `hidden` 标志（POSIX 上为点前缀约定），展示策略留在客户端；客户端绝不自行拼接路径段。`DirectoryListing.crumbs` 是从文件系统根到被列举目录的祖先链——每个 crumb 都是跳转目标，根 crumb 以完整路径标注。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

该 seam 建立在一个分离之上：后端提供的交互形态是约定，而不是实现细节。`DirectoryPicker` 是只有一个 `capability()` 方法的抽象 Cordis 服务；后端子类以 `ctx.directoryPicker` 注册，加载第二个实现会抛出标准的重复服务错误。能力对象在服务生命周期内必须保持稳定，因为消费方可能跨调用持有它。

### 可合并扩展的词汇表

`DirectoryPickerCapabilities` 是以能力类型为键的可合并扩展映射，`DirectoryPickerCapability` 从它派生联合类型。新后端在此通过声明合并且只修改这里（条目的 `kind` 字面量必须等于其键），而不改动本包。每个后端包还随附一个 browser 入口，在 ui-workspace 的 directory-flow slot 中注册匹配的交互，因此一行组合配置同时选择宿主能力与客户端流程。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition：抽象 `DirectoryPicker`、能力词汇、类型化错误、Context 合并 |

### 失败词汇

`DirectoryPickerError` 携带封闭的 `DirectoryPickerErrorCode` 加出错对象的绝对路径，消费方无需字符串匹配即可映射业务错误码。设计依据、与 `ctx.fs` 的切分与策略裁决见 seam Agent Note。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 seam 约定不够用时阅读以下内容：先看决策记录，再看组合它的两个后端与自适应选择器。

- [目录选择能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md)——设计依据、`ctx.fs` 切分与策略裁决。
- [原生后端](../directory-picker-native/README.zh.md)——OS 选择器交互及其平台工具。
- [浏览后端](../directory-picker-browse/README.zh.md)——面向远程客户端的应用内列举与创建交互。
- [自适应选择器](../directory-picker-auto/README.zh.md)——两个后端之间的启动时判定。
- [工作区子系统](../../../docs/subsystems/workspace.zh.md)——被选目录所喂给的工作区记录。

-----

<a id="model-experience"></a>
## 模型体验

无。GUI 宿主的目录选择 seam 不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 seam 约定何时把决定留给未来的消费方。它们是当前包约束，不是任务积压。

- **不支持多根目录**——浏览约定每次列举只公开一条祖先链；按部署限定浏览根（以及在盘符根的上一级枚举 Windows 各盘符根目录）等到出现需要它的消费方再做，见 DirectoryPicker Agent Note。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个无状态 Service Definition 只定义 capability vocabulary，观察由 backend 与 Remote controller 负责。
