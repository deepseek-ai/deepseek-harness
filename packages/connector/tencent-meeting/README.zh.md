---
description: "把腾讯会议插件加入 profile：官方 tmeet 及其技能，以及插件页上的腾讯会议登录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tencent-meeting

[English](README.md) | 中文

## 概述

腾讯会议插件让对话通过官方 `tmeet` CLI 使用腾讯会议。安装本 bundle 会添加两行：CLI 及其技能，以及插件页上的腾讯会议账号区块，用户无需先发起对话就能在那里登录和退出登录。CLI 把登录保存在默认配置中，与用户自己的终端共用。仅支持 macOS。

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

### 安装到 profile

在 Web 侧栏的 **插件** 页面或用 CLI 安装本 bundle：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-tencent-meeting
dsh plugin --profile web remove @deepseek-ai/dsh-tencent-meeting
```

`@tencentcloud/tmeet` 声明了安装脚本，因此第一次安装会停下来，待处理的构建脚本中列出 `@tencentcloud/tmeet`。在插件页面选择 **允许这些脚本并重试**；使用 CLI 时，在 profile 的 `pnpm-workspace.yaml` 中把它的 `allowBuilds` 设为 `true`，然后重新运行命令。该脚本会把包里的可执行文件设为可执行，并运行 `tmeet auth logout`，这会退出这台电脑上 tmeet 的登录，包括用户自己的终端。这项允许会保留在 profile 中，因此之后每次安装新版本的 `@tencentcloud/tmeet` 都会运行该脚本并再次退出登录；之后在插件页面重新登录即可。

### 你会得到

| 行 | 包 | 行为 |
|---|---|---|
| `tencent-meeting` | [`@deepseek-ai/dsh-tencent-meeting-cli`](../tencent-meeting-cli/README.zh.md) | 把 `tmeet` 放进私有 Shell PATH，注册其技能，并在 Host 上运行账号检查、登录和退出登录 |
| `ui-tencent-meeting` | [`@deepseek-ai/dsh-client-ui-tencent-meeting`](../../client/ui-tencent-meeting/README.zh.md) | 在插件页显示腾讯会议账号区块、连接标签、开启 bundle 后的引导以及提示 |

关闭本 bundle 会撤回技能、私有 PATH 条目和页面。CLI 的登录会保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 的其他层之后插入 `tencent-meeting` 和 `ui-tencent-meeting` 两行。本包依赖这两个行包，使它们从本 bundle 解析，[`src/index.ts`](src/index.ts) 不导出任何内容。插件页以本包名为账号区块的键。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [腾讯会议 CLI 与技能](../tencent-meeting-cli/README.zh.md) — Host 行、它的账号操作和模型指引。
- [腾讯会议插件页面](../../client/ui-tencent-meeting/README.zh.md) — 插件页行。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md) — 安装、构建脚本审批与启用。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 `tencent-meeting` 行体现：该行的包负责其[模型体验](../tencent-meeting-cli/README.zh.md#model-experience)中描述的技能目录条目和加载后的技能正文；`ui-tencent-meeting` 行不增加任何面向模型的内容。

#### KV Cache 影响

除 `tencent-meeting` 行的技能目录外没有影响；本 bundle 自身不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS；各行包列出了自己的限制。
- 安装新版本的 `@tencentcloud/tmeet` 会退出这台电脑上 tmeet 的登录，因为已允许的安装脚本会运行 `tmeet auth logout`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
