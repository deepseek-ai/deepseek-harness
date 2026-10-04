---
description: "在通用设置中控制随 DeepSeek API 请求上传会话日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-session-log

[English](README.md) | 中文

## 概述

使用**设置 → 通用**中版本号上方的**在使用官方模型 API 时上传 Session Log**开关控制随 DeepSeek API 请求上传会话日志。开关显示 Host 已接受的设置，并立即保存每次修改。仅当 Host 提供上传设置时显示该项；只读客户端无法修改。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 挂载本配套插件。开关通过共享配置表单修改 Host 插件的 `enabled` 字段。保存失败时保留已接受的值，并显示关闭设置后仍可见的提示。请求生效时机、恢复上传和独立的 OpenTelemetry 设置见[会话日志上传](../../session/session-log-deepseek/README.zh.md#configuration)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 提供 `session-log-deepseek` 时，配套插件贡献一个 `settings.general.item` 行，并通过 `shell.overlay` 提示保存结果。共享表单负责持久化和重连同步；配套插件仅管理待完成写入状态和本地化提示。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [设置表单](../ui-settings/README.zh.md)——Host 已接受的值与有序写入。
- [会话日志上传](../../session/session-log-deepseek/README.zh.md)——请求字段与接收进度。
- [Web 客户端](../../../docs/subsystems/web-client.zh.md)——插件组合与设置位置。

<a id="model-experience"></a>
## 模型体验

无；此浏览器设置不贡献模型可见内容。

#### KV Cache 影响

无；该设置控制模型输入之外的请求元数据。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- Host 不提供 `session-log-deepseek` 命名空间时，该行不可用。

<a id="dev-note"></a>
### 开发备注

无。
