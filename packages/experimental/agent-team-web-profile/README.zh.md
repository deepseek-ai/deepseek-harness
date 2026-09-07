---
description: "在 Host Team 层之后，为源码 checkout 的 Web profile 添加实验性 Agent Teams 面板。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-team-web-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team-web-profile` 是 [Agent Teams](../agent-team/README.zh.md) 的私有 Web 层。把它放在 `@deepseek-ai/dsh-web-app` 与 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 之后，即可在浏览器中显示 Team roster、任务板与 teammate 导航。移除任一实验层都会让稳定的 base 与 Web composition 保持不变。正式发布会排除本包，因此只能从源码 checkout 使用。

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

在本仓库 checkout 中，按以下顺序把 Host 与 Web Agent Teams 层添加到已初始化的 `web` profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-profile
pnpm dsh plugin --profile web add ./packages/experimental/agent-team-web-profile
```

第一条命令提供 Team domain、生成的 Remote 方法与模型工具。第二条命令激活本包声明的 patch 及其浏览器 presentation。执行 `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-team-web-profile` 移除本包时，Web 层也会从 profile 的有序 bundle 列表中移除。

### 获得的功能

对话标题栏会获得 Team roster、共享任务板与 teammate 导航。[`@deepseek-ai/dsh-experimental-client-ui-agent-team`](../client-ui-agent-team/README.zh.md) 负责这些浏览器交互，并挂载用于访问 Host Team service 的生成 Client Remote namespace。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-web-app` 与 Host Agent Teams 层之后应用时，它唯一的 `insert` 条目会为 `@deepseek-ai/dsh-experimental-client-ui-agent-team` 添加 `ui-agent-team` 行。插入的 Client 插件负责生成的 Remote assembly 与 Team UI；这个静态 bundle 不持有可变状态，也不安装运行时不变式。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 包含 `ui-agent-team` 行的有序 Web patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| — | 不发布运行时不变式伴生入口；本包是静态 bundle，不持有可独立观察的运行时关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布排除规则。
- [Agent Teams Host profile](../agent-team-profile/README.zh.md)——所需的 domain、Remote 与模型工具层。
- [Agent Teams 浏览器 UI](../client-ui-agent-team/README.zh.md)——roster、任务板与 teammate 导航行为。
- [Web bundle](../../bundle/web-app/README.zh.md)——本 patch 扩展的稳定浏览器层。

-----

<a id="model-experience"></a>
## 模型体验

通过与本 Web 层同时选择的 Host-side Agent Teams profile 间接产生影响。

#### KV Cache 影响

本 Web bundle 不添加任何模型请求内容；Host-side Team 工具负责提示词、schema 与缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **有序组合**——`dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile` 与本包必须保持这个顺序。
- **Preset-scoped 旧控制项**——稳定 Web preset 仍会在 preset scope 内挂载 continuable Subagent 控制项。顶层 Host profile override 不会替换这些 scoped registration，因此在 Web 获得 Team-aware preset 前，Team roster 与旧 child 控制项可能同时出现。[Web Agent Teams 决策](../../../.agents/notes/archived/feature/2026-08-06-agent-teams-web.md)记录了这项暂缓的 composition 工作。
- **仅限源码 checkout**——正式 CLI、Web、npm 与 Python 发布产物都不包含这个私有包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
