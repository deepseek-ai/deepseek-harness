---
description: "把飞书插件加入 profile：带内嵌技能的官方 lark-cli，以及插件页上的飞书账号连接。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-feishu

[English](README.md) | 中文

## 概述

飞书插件让对话通过官方 `lark-cli` 使用飞书。安装这个 bundle 会加入两行：带内嵌技能的 CLI，以及插件页上的飞书账号区块；用户在插件页关联应用并登录，不需要先开始对话。CLI 把账号保存在默认配置中，与用户自己的终端共用。仅支持 macOS。

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
dsh plugin --profile web add @deepseek-ai/dsh-feishu
dsh plugin --profile web remove @deepseek-ai/dsh-feishu
```

pnpm 会拦截 `@larksuite/cli` 的安装脚本，该脚本负责下载并校验官方原生程序；请通过插件页的**允许这些脚本并重试**，或 [Plugin Manager](../../boot/plugin-manager/README.zh.md) 记录的其他方式批准。可执行文件存在之前，`feishu` 行会加载失败，并给出缺失的路径。

### 获得的能力

| 行 | 包 | 行为 |
|---|---|---|
| `feishu` | [`@deepseek-ai/dsh-feishu-cli`](../feishu-cli/README.zh.md) | 把 `lark-cli` 放进私有 Shell PATH，注册其内嵌技能，并在 Host 上执行账号检查、连接和退出登录 |
| `ui-feishu` | [`@deepseek-ai/dsh-client-ui-feishu`](../../client/ui-feishu/README.zh.md) | 在插件页显示飞书账号区块、连接标签、开启后的连接引导和连接提示 |

关闭 bundle 会撤下技能、私有 PATH 条目和页面。CLI 的配置与登录保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 其他层之后插入 `feishu` 与 `ui-feishu` 两行。本包依赖这两个行包，使两行都从本 bundle 解析；[`src/index.ts`](src/index.ts) 不导出任何内容。插件页以本包名作为账号区块的 key。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md)——这个应用插件所属的分组。
- [飞书 CLI 与技能](../feishu-cli/README.zh.md)——Host 行、账号操作与模型指引。
- [飞书插件页面](../../client/ui-feishu/README.zh.md)——插件页行。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——安装、构建脚本批准与启用。

-----

<a id="model-experience"></a>
## 模型体验

间接地通过 `feishu` 行产生，该行所属的包负责技能目录条目和加载后的技能正文，见其[模型体验](../feishu-cli/README.zh.md#model-experience)；`ui-feishu` 行不增加任何模型可见内容。

#### KV Cache 影响

除 `feishu` 行的技能目录外没有影响；bundle 本身不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS；两个行包各自列出其限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
