---
description: "settings 与凭据配置界面的 Host Remote owner，涵盖脱敏读取、写入、凭据引用与原生文档打开。"
kind: "package-reference"
---
# Settings Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-settings-controller` 为浏览器配置界面提供生成的 `ctx.remote.settings` 与 `ctx.remote.credentials` namespace。它返回脱敏的 settings 与凭据元数据，支持 settings 与凭据写入而不返回密钥值，并在 Host 桌面打开由 provider 持有的 settings 或 Agent preset 位置。provider 缺失时，namespace 仍会注册，并返回可操作的配置错误。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请把本包作为 Loader entry 挂载到提供浏览器配置的 profile 中。本 entry 不依赖 provider 是否存在而注册两个 namespace，因此缺少 provider 会在调用时产生具名配置错误。它生成的 descriptor 进入严格 Typert registry，而 settings 与凭据 Definition 仍是普通 Cordis Service，自身不承担任何 wire 义务。

`describe(refs)` 以请求的名字为键返回一份 map，因此设置页描述其各行携带的全部引用时，这些行会一起落定。单次调用最多接受 64 个名字，无效名字或空写入值报告为 `bad-request`，并逐字段复制每个答案——provider 返回超出 `CredentialInfo` 声明的内容也无法扩大跨越 wire 的字段。有效的 `set(ref, value)` 与 `unset(ref)` 调用把 provider 拒绝报告为 `credential-rejected`，携带 provider 的消息，details 中只有该引用。密钥值只在这个方向跨越 wire：这里没有任何方法会返回它。

`settings.describe()` 返回部署信息，以及在 `redactSecrets: true` 下读取的所有 namespace。`settings.update`、`settings.replace` 与 `settings.mutate` 暴露 settings service 的三种写入操作，并返回该 namespace 的新脱敏视图；过期写入使用 `settings-conflict`，其他 provider 拒绝使用 `settings-rejected`。

`settings.openSettingsDocument()` 准备 provider 持有的文档，并用原生文本编辑器意图将其打开。`settings.canOpenAgentPresetDirectory()` 在 preset 页面显示时报告原生打开能力。`settings.openAgentPresetDirectory(id)` 只解析用户创作的 preset，并在原生打开不可用时返回目录路径；两个打开方法都不接受浏览器提供的文件系统目标。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `nativeOpen` | 平台探测 | Agent preset 目录能否交给原生桌面打开器 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-settings-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 settings 与凭据配置属于浏览器和 Host 状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；读取或写入这些配置值不会改变已经在途的模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 批量上限固定为 64 个引用，不是可按部署配置的字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。settings 与 credential seam 负责存储和更新事件，本包只把它们的方法投影到 wire。
