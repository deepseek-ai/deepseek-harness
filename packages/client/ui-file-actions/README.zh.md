---
description: "下载和另存原始文件时保持编码不变"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-actions

[English](README.md) | 中文

## 概述

下载和另存原始文件时保持编码不变。图片复制为可粘贴的 PNG 内容，保存则保留原始格式。Desktop 可以显示成功保存的文件位置；浏览器下载不会声称知道其本机目标路径。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 应用 bundle 无配置字段地挂载此客户端插件。使用方导入 `/client` 类型并注入 `fileActions`。Desktop 为 Chromium 下载和跨域剪贴板读取提供可选的可信页面适配器。Desktop 与 Web 均通过浏览器 Clipboard API 写入 PNG 图片。

### 原始内容

传入原始 URL、可选文件名和 MIME；会话文件也可提供经授权的 `read(signal)` 回调。保存保持字节不变。MIME 与文件名冲突时修正后缀；兼容和未知后缀保持不变。建议名称去除平台保留字符和设备名称，并限制在 255 字节以内。

`save(source, mode)` 返回取消状态 `cancelled`、浏览器下载已请求状态 `requested`，或原生保存完成后的 `saved` 及目标绝对路径 `path`。Web 的文件和图片菜单提供「下载」，不显示「另存为」。Web 下载将原始内容和建议文件名交给浏览器，由浏览器负责保存位置和完成状态，不返回本机路径。「另存为」仅限 Desktop：Web 的 `canSaveAs` 为 false，调用 `saveAs` 会在读取来源前拒绝。

Desktop 完成提示提供「在文件夹显示」文字操作（macOS 为「在 Finder 显示」），捕获该次操作的目标路径。该操作调用 `session.openWorkspacePath`，复用现有 Host 路径校验，不保留下载历史或独立的 reveal IPC。右键菜单中的定位由 `ui-open-in-app` 提供，始终针对原本就在本地的文件，不受此前保存影响。

文件名与 MIME 规范化复用文件拖动工具，因此保存与拖动采用相同的原始格式和文件名规则。

下载原始内容时，响应 MIME 优先于建议文件名或媒体类型。图片复制将捕获的原始内容解码为 PNG，保证剪贴板互通。`copyImageAt` 定位坐标上的当前内容，没有完成回执，也不能绑定卡片或键盘菜单捕获的图片。因此，即使图片移动、替换或被菜单遮挡，复制仍读取捕获的来源。下载与另存为不使用该转换。本插件通过 `ctx.contextMenus` 贡献文件和图片的复制、下载、另存为及本地化提示，不依赖 `ui-open-in-app`。其他服务调用方负责自己的提示。读取失败不会开始写入。Desktop 下载使用 `webContents.downloadURL` 与 `DownloadItem`：直接来源保留为 URL，经授权的 Session 读取转为临时 Blob URL 并保留到完成。响应 MIME 决定原始文件名，下载独占不同路径，另存为使用 Chromium 的保存对话框和替换行为。仅完成事件返回目标路径；取消不提示，下载中断显示失败。导航或关闭窗口会取消待完成的下载。插件释放时取消浏览器读取及待完成的定位请求，并释放对象 URL。

Desktop 下载遵循 Chromium 会话及网络策略。只有剪贴板回退读取使用有界、无凭据的 HTTP(S) 读取器，每次重定向均禁止访问应用 Host。其他目标遵循本机网络策略。普通 Web 读取要求远端服务允许浏览器 CORS；响应被拒绝时显示失败提示，不开始保存。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

客户端在插件生命周期开始时选择浏览器或原生操作。[客户端实现](src/client/files.ts) 管理 MIME 归一化与剪贴板转换。[Desktop 适配器](../../../apps/desktop/src/file-actions.ts) 验证 IPC 输入，并在返回完成后的目标路径前重新验证可信窗口。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [右键菜单](../ui-context-menu/README.zh.md) — 操作贡献。
- [工作区文件](../../api/workspace-files/README.zh.md) — 授权会话读取。
- [Desktop](../../../apps/desktop/README.zh.md) — 原生操作设置。

-----

<a id="model-experience"></a>
## 模型体验

无，因为用户主动的文件和剪贴板操作不会构造模型输入。

#### KV 缓存影响

无；保存与复制不改变模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 另存为仅限 Desktop；剪贴板操作依赖浏览器权限和图像解码支持。
- 原生下载具有可配置的启动期限；Chromium 接管后，以完成或取消事件结束操作。HTTP(S) 剪贴板读取不携带凭据，窗口导航、关闭、超时或达到配置字节上限时停止。
- 浏览器下载不提供文件定位，除非另有已知、实际存在的 Host 文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
