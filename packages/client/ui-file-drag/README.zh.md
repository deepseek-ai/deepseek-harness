---
description: "应用作用域内的文件传递与本地化拖放失败反馈。"
kind: package-reference
---

# @deepseek-ai/dsh-client-ui-file-drag

[English](README.md) | 中文

## 概述

用户可以把会话或侧栏中的原图拖回输入框，也可以通过桌面端拖到其他应用。图片或面板关闭后，拖放失败提示仍然可见。浏览器跨窗口传递受浏览器能力限制。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Web profile 将该插件与 locale、插槽渲染器及声明 `shell.overlay` 的外壳一同加载。消费方注入 `fileDrag`，通过入口的注入接口传递 `ctx.fileDrag.actions`。`prepare(source, signal)` 接受 Blob 或 URL 内容、导出名及可选 Session 资源地址，返回同步启动和释放操作。`reportFailure()` 使用插件词典；失败提示和插件元数据提供中文、英文与日语。输入框接收方获取 `ctx.fileDrag.read`；组件不读取服务或 React context。

服务为一次浏览器拖放保留一个原始 `File`。随机的 `application/x-dsh-file` 令牌只能在所属应用实例解析。原生监听器在 React 卸载后仍绑定源节点，拖放结束、投放完成或插件卸载会清除传递。内部令牌仅在输入框范围接受；外部文件保留已有的全页投放遮罩。Desktop 原生拖放返回时属于普通文件，包括拖回源窗口，也使用该遮罩。

桌面桥接在插件激活时解析一次，支持协议版本 1。文件命名通过 [dsh-util-file-drag](../../util/file-drag/README.zh.md) 与桌面端共享：显式后缀优先，兼容后缀保留，已知冲突使用声明 MIME 的后缀，未知类型保留调用方名称。失败文案与覆盖层由插件持有，在源面板关闭后仍然可见。

托管浏览器传输携带应用内令牌，以及指向插件持有、包含准备字节的 Blob URL 的 `DownloadURL`，不会通过 `text/plain` 暴露源工作区 URL、文件名或替代文本。准备完成前起拖会静默取消；已确定的失败在下一次尝试时显示本地化重试提示。带资源引用的图片仅在主指针按下时准备，其他来源可在悬停时准备。在源图片内松开会保留准备，供后续起拖使用。未按住拖动时移出图片、在图片外松开、窗口失焦或卸载会释放未使用的准备。取消会传递到原生请求，包括 Host 读取和图标等待。可选资源借用失败后回退到传入的 Blob 或经过授权的 URL 读取；取消不会触发回退。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节</summary>

Cordis 插件负责文件准备、传输选择、浏览器保留字节与临时反馈。[DraggableImage](../ui-primitives/README.zh.md) 处理图片手势，[Desktop](../../../apps/desktop/README.zh.md) 授权借用资源并持有原生临时导出。图片是首个调用方，同一组回调可接收 PDF 等文件内容，不设图片 MIME 门禁。

</details>

<a id="model-experience"></a>
## 模型体验

无；该插件只改变浏览器交互，不增加模型可见消息或工具。

#### KV Cache effect

无；该插件既不构建也不发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器令牌不能跨应用、窗口或标签页传递。浏览器向外部交付文件依赖 Chromium 的 `DownloadURL` 和接收应用；Desktop 提供原生文件交付。不可读取的跨域图片保留浏览器原生拖动。
- Blob `DownloadURL` 路径尚无经过验证的外部应用交付结果。传递结束后才读取的接收方可能遇到 URL 已撤销；需要原始文件交付时使用 Desktop 原生拖放。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
