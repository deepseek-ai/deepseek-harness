---
description: "面向 Web GUI 用户与维护者的模型上下文：给出 DeepSeek Harness checkout 与 GUI URL，且两者都不会改变系统提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-dev-context

[English](README.md) | 中文

## 概述

`dsh-harness-dev-context` 告诉运行在 DeepSeek Harness Web GUI 背后的 agent：harness 实现 checkout 在哪里、GUI 与「this page」是什么关系，以及哪个 URL 提供该 GUI。系统提示词只包含不含值的说明；当前 checkout 路径与 GUI URL 以运行时上下文送达，因此从别的 checkout、端口或安装位置启动进程，绝不会改写会话已记录的系统提示词。提示词仍嵌有早期版本这些值的会话会原样保留那段文本。

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

随附的 Web bundle 以 `harness-dev-context` 行挂载此插件。不希望 agent 得知 harness checkout 或 GUI URL 时，在 profile patch 中禁用该行。插件不接受配置，只在每个注入服务都存在时激活：`systemPrompt`、`sessionProjections`，以及 Web 运行时的 `webApp` 服务，因此 `--help` 与非 Web 组合永远不会挂载它。

### 模型得到什么

两个系统提示词段落说明 checkout 与工作目录不同、「this page」指此 GUI，并给出 GUI 的更新约定。两行运行时上下文给出当前值：本包上方四层目录处的安装根，以及 `webApp.getAdvertisedUrl()` 给出的 Web GUI 公告 URL，与 `DSH_WEB_URL` 和启动 URL 相同。运行时上下文遵循共享的快照规则：值不变不追加内容，值变化时在本步输入之前追加一份快照，而不是改写更早的消息。

### 早期版本的会话

早期版本把两个值都嵌在系统提示词里。会话最新的非空系统提示词仍含那两段原文时，两个段落会原样重复它们（包括旧值），因此升级以及之后更换端口或 checkout 都不会改变该会话提示词的任何字节；运行时上下文行仍给出当前值。只是看起来像早期段落的文本会得到当前说明。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计思路

仅限宿主的会话投影 `harnessDevLegacyPrompt` 把每个已提交的非空 `system/message` 折叠为其中包含的早期格式段落，按值两侧的固定文本在同一行内匹配。段落文本提供函数通过 `AssembleContext.agent` 读取该状态；没有 agent 的组装使用当前说明。会话恢复时该投影与其他单元一起恢复，因此不同步读取任何历史事件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：段落、运行时上下文、早期格式投影 |

### 主流程

激活时等待取得投影 handle，再注册两个段落与两个上下文。每次组装时，段落读取 handle，在已提交的早期段落与当前说明之间选择；每次请求准入时，上下文读取公告 URL。销毁插件 fiber 会移除全部注册。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读这些页面。它们从决策记录走到本插件读取的服务。

- [进程相关值改走运行时上下文](../../../.agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.zh.md)——这些值为什么离开系统提示词，以及早期会话如何保持稳定。
- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——早期格式状态使用的投影约定。
- [Web app bundle](../../bundle/web-app/README.zh.md)——`webApp` 服务与挂载本插件的行。
- [Context 组地图](../README.zh.md)——同组的请求上下文包。

-----

<a id="model-experience"></a>
## 模型体验

### Harness checkout 与 Web GUI

#### 模型看到什么

两个系统提示词段落，位于可复用指令之后的第一方顺序 10000 与 10100；两行运行时上下文，位于上下文顺序 200 与 210。在早期版本下提交过提示词的会话看到的是自己的早期段落，而不是下面两段。

##### 系统提示词段落

```markdown
The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.

You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.
```

##### 运行时上下文行

```markdown
Current DeepSeek Harness implementation checkout: "<installation root>".

Current DeepSeek Harness Web GUI URL: "<advertised URL>".
```

#### Token 影响

每个会话两段提示词，每份运行时上下文快照两行。checkout 或 URL 变化时追加一份快照。

#### KV Cache 影响

系统提示词在不同 checkout、端口与安装位置下完全相同，因此在别处启动的进程不会破坏已缓存的前缀；值变化时在其后追加一份运行时上下文快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明稳定性保证覆盖哪些内容。它们是当前包约束。

- **只覆盖两段**——版本之间变化的其他系统提示词文本，在不支持 in-history 提示词更新的路由上仍会改写第一条 system 消息。
- **早期值保留**——早期格式会话在整个生命周期内都在系统提示词里保留旧 checkout 路径与 URL；只有之后的运行时上下文行是当前值。
- **混用版本**——不含本包的版本会改写以本包启动的会话的第一条 system 消息，因此共用同一 `DSH_HOME` 的每个 checkout 都需要先包含本包，才能交替运行。
- **可选值**——两行运行时上下文是可选的，因此设置 `includeRuntimeContext: false` 但未设置 `complete: true` 的自定义 persona 会保留指向其请求从不携带之值的段落。随附的 `minimal` persona 两者都设置。
- **没有段落的会话**——在 `surfaceContext: false` 隐藏两段时创建的会话，日志中两段都没有，因此恢复后的第一个请求会加入新段落，并在不支持 in-history 提示词更新的路由上改写第一条 system 消息。
- **只认一版早期措辞**——投影按本包之前紧邻的版本渲染的段落识别；保存更早措辞的会话会得到当前说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
