---
description: "preset 挂载的可组装人设行，让单个 agent 拥有自己的系统提示词人设，供配置或排查它的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-persona

[English](README.md) | 中文

## 概述

`dsh-persona` 让单个 agent（智能体）拥有自己的人设：preset 挂载这一可组装的行来注册人设前缀与后缀段落，为该会话遮蔽部署级默认值。它还可以把前缀变成该会话的完整系统提示词、抑制所有其他段落，并可为该会话关闭动态 runtime-context 快照。请把它挂在 preset 组装内部——全局挂载会与提示词注册表自身的人设注册相撞并明确报错。没有这一行，preset 能改变 agent 的工具，却永远改不了它的身份。

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

在 preset 组装内部挂载本行，让该 preset 的会话拥有自己的人设。本行需要 agent scope：在 scope 之外挂载会与提示词注册表自身的 `deployment:persona-prefix` 注册相撞并明确报错——部署级人设已经有归属，而本行存在的意义正是为某一个 agent 遮蔽它。

### 配置

```yaml
- name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a terse systems engineer who answers in short commands.
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `prefix` | 必填 | 作为 `deployment:persona-prefix` 段落渲染的人设文本 |
| `suffix` | `''` | `deployment:persona-suffix` 模板；省略或空文本会遮蔽掉全局后缀 |
| `complete` | `false` | 仅将渲染后的前缀用作系统提示词；忽略后缀 |
| `includeRuntimeContext` | `true` | 是否为此 agent 作用域包含动态 runtime-context 快照；false 会抑制所有上下文贡献，但不禁用拥有它们的服务 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-persona)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 人设行为

人设 `prefix` 与 `suffix` 都是模板：完整的 `{{…}}` 组在提示词**渲染**时（而非组装时）严格解析为已注册的提示词变量。每个空模板仍会遮蔽对应的部署级段落，然后在渲染时消失。省略 `suffix` 时默认为空，不继承全局后缀。启用 `complete: true` 时，组装仍会解析上下文、工具、变量与协作式监听器，但提示词注册表会把这确切前缀恢复为唯一段落；身份、后缀、工具引导或监听器都无法追加提示词文本。启用 `includeRuntimeContext: false` 时，此作用域的上下文提供方不会被求值，组装监听器添加的上下文也会被丢弃。

### 何时使用

当 preset 必须改变 agent 的身份、而不只是工具时，使用本行。部署级人设本身配置在 `dsh-system-prompt` 行上，不在这里；本行只用于为某一个 agent 遮蔽或替换它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 本行如何注册

本行使用注册表共享的名称与具名顺序来注册带作用域的人设前缀与后缀段落。两者分别遮蔽对应的部署默认值，而不是出现在其旁边；排序、插值与完整提示词执行归注册表所有。`includeRuntimeContext: false` 会调用 `ctx.systemPrompt.suppressRuntimeContext()`。

### 本行为何仅限 scope 内使用

`dsh-system-prompt` 以自身配置持有全局人设并无条件注册 `deployment:persona-prefix`，因此一个进程只有一份。本行在 agent scope 之外与该项注册相撞，这是刻意的：本行的存在是因为 preset 无法自行挂载提示词注册表。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、人设段落注册、runtime-context 抑制 |
| — | 不发布运行时不变式伴生入口；身份、完整提示词执行与资源释放归提示词注册表。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从 preset 组装逐步进入本行所供给的提示词注册表。

- [agent-presets 包](../agent-presets/README.zh.md)——本行挂载进的 preset 组装。
- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——段落、组装，以及本行所遮蔽的人设槽位。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-persona)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 人设段落

#### 模型看到什么

位于 order `0` 的 `deployment:persona-prefix` 段落携带本行的 `prefix`；位于 order `10200` 的 `deployment:persona-suffix` 在第一方指导之后携带其 `suffix`。两者分别替换对应的部署默认值，并解析提示词变量。在完整模式下，模型只会看到渲染后的前缀段落作为系统提示词。Runtime context 默认保持启用；禁用后，新建 agent 不会收到来自沙箱策略、批准策略、委派或其他 system-prompt 上下文提供方的 runtime-context 快照。

#### Token 影响

对给定 preset 而言是固定的：该 agent 的每次请求都携带人设前缀与后缀的 token，其他 agent 一个都不带。空文本不贡献任何 token。完整模式会移除该 agent 的其他所有系统提示词 token。

#### KV Cache 影响

渲染后的模板变量与文本不变时，前缀保持稳定。模型、前缀与工具一致时，后缀变化不改变前置指令。前缀变化会影响靠前的前缀；不保证提供方共享缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本行何时不合适。它们是当前包约束，不是任务积压。

- **不支持全局挂载**——提示词注册表拥有未加 scope 的人设槽位，因此本行只能从带 scope 的组装中使用。要改变部署级人设，应在 `system-prompt` 行自身的配置中修改。
- **runtime-context 抑制是全有或全无**——`includeRuntimeContext: false` 会关闭该作用域的所有上下文贡献，包括沙箱策略、批准策略与委派；没有按提供方过滤的选项。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
