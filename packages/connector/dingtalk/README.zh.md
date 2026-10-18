---
description: "把钉钉插件加入 profile：官方 dws 及其技能，以及插件页上的钉钉登录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-dingtalk

[English](README.md) | 中文

## 概述

钉钉插件让对话通过钉钉官方 CLI（DingTalk Workspace CLI，命令 `dws`）使用钉钉。安装本 bundle 会加入两行：CLI 及其技能，以及插件页上的钉钉账号区块，用户不必开始对话就能在这里登录和退出。CLI 把登录保存在 `~/.dws` 和系统钥匙串中，与用户自己的终端共用。仅支持 macOS。

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

在 Web 侧边栏的**插件**页面安装，或使用 CLI：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-dingtalk
dsh plugin --profile web remove @deepseek-ai/dsh-dingtalk
```

本 bundle 没有需要批准的安装脚本。插件加载时，`dingtalk` 行会从固定版本的 release 把当前平台的 dws 及其技能下载到 Harness 缓存，因此第一次加载需要能访问 GitHub 或官方 Gitee 镜像。登录需要一个已加入组织的钉钉账号，并且组织管理员已开启 CLI 访问。

### 你会得到

| 行 | 包 | 行为 |
|---|---|---|
| `dingtalk` | [`@deepseek-ai/dsh-dingtalk-cli`](../dingtalk-cli/README.zh.md) | 下载 `dws` 及其技能，把 `dws` 放进私有 Shell PATH，注册其技能，并在 Host 上执行账号检查、登录和退出登录 |
| `ui-dingtalk` | [`@deepseek-ai/dsh-client-ui-dingtalk`](../../client/ui-dingtalk/README.zh.md) | 在插件页上显示钉钉账号区块、连接标签、开启 bundle 后的引导和提示 |

关闭 bundle 会撤下技能、私有 PATH 条目和页面。CLI 的登录和已下载的资产会保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 在 profile 的其他层之后插入 `dingtalk` 和 `ui-dingtalk` 两行。本包依赖这两个行包，使这两行从本 bundle 解析；[`src/index.ts`](src/index.ts) 不导出任何内容。插件页按本包名定位账号区块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Connector 包](../README.zh.md) — 本应用插件所属的分组。
- [钉钉 CLI 与技能](../dingtalk-cli/README.zh.md) — Host 行、它的下载、账号操作和模型指引。
- [钉钉插件页面](../../client/ui-dingtalk/README.zh.md) — 插件页行。
- [Plugin Manager](../../boot/plugin-manager/README.zh.md) — 安装与启用。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 `dingtalk` 行，其包拥有技能目录条目和加载后的技能正文，见其[模型体验](../dingtalk-cli/README.zh.md#model-experience)；`ui-dingtalk` 行不增加任何面向模型的内容。

#### KV Cache 影响

除 `dingtalk` 行的技能目录外没有影响；bundle 本身不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 macOS；各行包列出了各自的限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
