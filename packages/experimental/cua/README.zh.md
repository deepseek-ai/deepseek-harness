---
description: "复用 Computer Use 应用和窗口对象，通过已授权并记录日志的平台操作完成任务。"
kind: "package-library"
---

# @deepseek-ai/dsh-cua

[English](README.md) | 中文

## 概述

检查应用、跨 PTC 调用保留窗口对象，并通过正常工具执行链发送动作。平台提供方负责原生执行；本库负责对象 API、请求校验、应用授权和图像接纳。变量持久性由外部 PTC 运行时负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载 [macOS 提供方](../cua-macos/README.zh.md)以启用原生操作。外部 PTC 宿主从 `@deepseek-ai/dsh-cua/bridge` 导入 `connectCua`，并提供当前 `tools.cua` 绑定。源码组合与原生组件准备由提供方负责。

单窗口任务直接使用 App 方法。`getApp` 读取初始辅助功能状态；需要指定窗口时使用 `getWindows` 和 `getWindow`。重新读取一个应用或窗口范围会替换其中的元素编号，不使其他窗口的快照失效。键盘输入跟随应用焦点。请求参数校验失败时，在分派前返回包含方法、参数和要求的可读消息。

观察方法会输出并返回结果。使用 `void await app.getAXState()` 只展示一份内容，或使用 `emit:false` 后打印一次返回文本。截图返回包含 `bytes`、`mimeType`、`pixelWidth`、`pixelHeight` 和 `windowId` 的 `CuaScreenshot`，图片输出回调接收同一个对象。选择文件后缀或声明图片时使用其中的 MIME 类型；格式可能是 PNG、JPEG、WebP 或 GIF。每张截图只进入一次附件处理链；`emit:false` 只抑制对象层的输出。

`tools.cua` 直接返回操作结果。截图结果保留图片 Base64，并增加供工具渲染使用的持久 `attachment` 引用；模型内容只包含坐标元数据和一张图片，不包含编码字节。截图前要求附件服务可用，并确认当前模型支持图片输入。图片接入或保存失败会拒绝调用。对象桥接保留截图字节和已校验的元数据，不重复上传或输出同一张图片。

应用授权发生在启动、观察、截图和输入之前。任务许可绑定已选择的应用实例；长期许可要求平台验证可执行文件身份。撤销会关闭受影响的 Agent 连接，因此旧对象必须重新选择目标。取消、超时或重新连接后均不重放输入。

动作返回 `dispatched:true, verified:false`；请读取新状态以验证结果。坐标操作默认使用最近返回截图中的像素；成功观察窗口后，传入 `relative: true` 可使用 0～1000 的整数比例。Host 在返回截图前解析附件归一化和当前模型的图片缩放规则，再将输入换算为原生窗口 point。窗口尺寸变化会使截图映射失效，绝对坐标遇到 `SCREENSHOT_REQUIRED` 时需要重新截图。窗口缩放后以 `WINDOW_CHANGED` 拒绝旧坐标；单纯移动窗口不改变窗口内坐标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>共享执行与平台职责</summary>

提供方将准备好的 helper、连接工厂和指引传给 [installCua](src/index.ts)。[NativeClient](src/native-client.ts) 负责请求关联、字节上限、取消确认和失败处理。平台连接器负责启动和连接清理。共享执行器为每个 Agent 保留一个连接，并在销毁时等待进行中的图像写入。

[操作 schema](src/protocol.ts) 定义模型参数，并单独声明 Host 专用字段。原生实现在执行时检查目标身份、窗口几何、资源上限和操作系统访问条件。本库没有独立投影的注册表或持久状态，因此不发布 invariant 模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [macOS 提供方](../cua-macos/README.zh.md)
- [对象接口](src/types.ts)

-----

<a id="model-experience"></a>
## 模型体验

### 已授权的应用操作

#### 模型可见内容

平台提供方挂载共享的 `cua` 工具并提供操作指引。调用和观察使用同一套应用与窗口接口，进入正常 Session 历史。平台指引见 [macOS 提供方](../cua-macos/README.zh.md#model-experience)。

#### Token 影响

操作结果和接纳的图像增加模型输入。保留的 JavaScript 对象不会序列化进提示词。调用方重复打印会重复观察文本。

#### KV Cache 影响

结果追加到历史。保留对象不重写已有消息；更改挂载的工具或指引可能改变请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 当前原生执行使用 macOS 提供方。Windows 支持计划使用独立的提供方包和 C# helper，保留共享应用与窗口 API、授权、快照有效性和动作结果语义。实现须说明系统特有的限制，并区分交叉编译证据和 Windows 桌面验证。
- 持久变量不会在一组连续操作期间独占应用。其他 Agent 和用户可能改变其状态。 悬停和观察不恢复先前的鼠标位置；[连续交互](../../../.agents/notes/implemented/architecture/2026-10-13-cua-continuous-hover.zh.md)不分配跨调用所有权。
- 本包保留在 `experimental`，Windows 支持和平台验证完成后可迁至 `computer-use` 组。

-----

<a id="dev-note"></a>
### 开发备注

无。
