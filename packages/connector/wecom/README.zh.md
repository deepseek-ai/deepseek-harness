---
description: "把企业微信插件加入 profile：官方 wecom-cli 及其技能，以及插件页上的企业微信授权。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-wecom

[English](README.md) | 中文

## 概述

企业微信插件让对话通过官方 `wecom-cli` 使用企业微信。安装这个 bundle 会加入两行：带技能的 CLI，以及插件页上的企业微信授权区块；用户在插件页扫码绑定机器人，不需要先开始对话。CLI 把授权保存在默认配置中，与用户自己的终端共用。仅支持 macOS。

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

在 Web 侧栏的**插件**页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-wecom
dsh plugin --profile web remove @deepseek-ai/dsh-wecom
```

`@wecom/cli` 把原生程序放在 `@wecom/cli-darwin-arm64` 等平台包中，这些包安装时不运行构建脚本。没有与本机匹配的平台包时，`wecom` 行会加载失败，并给出缺失的包名。

### 获得的能力

| 行 | 包 | 行为 |
|---|---|---|
| `wecom` | [`@deepseek-ai/dsh-wecom-cli`](../wecom-cli/README.zh.md) | 把 `wecom-cli` 放进私有 Shell PATH，注册其技能，并在 Host 上执行授权检查和扫码连接 |
| `ui-wecom` | [`@deepseek-ai/dsh-client-ui-wecom`](../../client/ui-wecom/README.zh.md) | 在插件页显示企业微信授权区块、授权标签、开启后的引导和提示 |

关闭 bundle 会撤下技能、私有 PATH 条目和页面。CLI 的授权保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 其他层之后插入 `wecom` 与 `ui-wecom` 两行。本包依赖这两个行包，使两行都从本 bundle 解析；[`src/index.ts`](src/index.ts) 不导出任何内容。插件页以本包名作为授权区块的 key。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [企业微信 CLI 与技能](../wecom-cli/README.zh.md)——Host 行、授权操作与模型指引。
- [企业微信插件页面](../../client/ui-wecom/README.zh.md)——插件页行。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装与启用。

-----

<a id="model-experience"></a>
## 模型体验

间接地通过 `wecom` 行产生，该行所属的包负责技能目录条目和加载后的技能正文，见其[模型体验](../wecom-cli/README.zh.md#model-experience)；`ui-wecom` 行不增加任何模型可见内容。

#### KV Cache 影响

除 `wecom` 行的技能目录外没有影响；bundle 本身不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS；两个行包各自列出其限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
