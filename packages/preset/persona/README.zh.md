---
description: "preset 挂载的可组装人设行，让单个 agent 拥有自己的系统提示词人设，供配置或排查它的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-persona

[English](README.md) | 中文

## 概述

`dsh-persona` 通过普通系统段提供人设前缀与后缀。在 preset 中挂载可定制该 preset 的会话，全局挂载可覆盖部署默认值。它还可以把前缀变成完整系统提示词、抑制所有其他段落，并为其作用域关闭可选运行时上下文。

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

在 preset 组装内部挂载本行，让该 preset 的会话拥有自己的人设。全局挂载适用于未覆盖它的所有作用域。`system-prompt` 行提供这些注册之下的部署默认值。

### 配置

```yaml
- name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a terse systems engineer who answers in short commands.
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `prefix` | 必填 | 作为 `deployment:persona-prefix` 段落渲染的人设文本 |
| `suffix` | `''` | `deployment:persona-suffix` 模板；省略或空文本会清除此作用域的后缀 |
| `complete` | `false` | 仅将渲染后的前缀用作系统提示词；忽略后缀 |
| `includeRuntimeContext` | `true` | 是否为此 agent 作用域包含可选运行时上下文；false 会抑制可选贡献，但不禁用拥有它们的服务；必需贡献仍会保留 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-persona)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 人设行为

人设 `prefix` 与 `suffix` 都是模板：完整的 `{{…}}` 组在提示词渲染时严格解析为已注册的提示词变量。空模板会清除对应的人设文本。省略 `suffix` 时默认为空，不继承全局后缀。启用 `complete: true` 时，组装仍会解析上下文、工具、变量与协作式监听器，但提示词注册表会把这确切前缀恢复为唯一段落；身份、后缀、工具引导或监听器都无法追加提示词文本。启用 `includeRuntimeContext: false` 时，此作用域的可选上下文提供方不会被求值，组装监听器添加的贡献也会被丢弃，除非已注册为必需贡献。必需提供方在组装和请求接纳时仍然有效。

### 何时使用

当组合需要同时改变 agent（智能体）的身份与工具时，使用本行。Preset 和 agent 作用域覆盖外层人设段；同一作用域中，最后一个活跃注册优先。卸载本行后，每个段恢复下一个活跃定义。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 本行如何注册

本行分别为 `deployment:persona-prefix` 和 `deployment:persona-suffix` 调用 `ctx.systemPrompt.section()`，使用它们已登记的顺序位置。前缀携带 `complete`；后缀默认为空。Cordis 拥有这两个注册，清理通过普通段解析路径显露先前定义。`includeRuntimeContext: false` 会调用 `ctx.systemPrompt.suppressRuntimeContext()`。

### 覆盖如何组合

前缀和后缀使用独立段名称。本行注册两者，因此省略后缀会清空继承的后缀文本。只注册前缀的插件仍继承后缀。只要还有其他可见注册，移除一个注册便不会使其逻辑来源退役。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、人设段注册、runtime-context 抑制 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从 preset 组装逐步进入本行所供给的提示词注册表。

- [agent-presets 包](../agent-preset-registry/README.zh.md)——本行挂载进的 preset 组装。
- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——段、组装及此行配置的 persona 值。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-persona)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 人设段落

#### 模型看到什么

顺序为 `0` 的 `deployment:persona-prefix` 段承载此行的 `prefix`；顺序为 `10200` 的 `deployment:persona-suffix` 段在第一方指导之后承载其 `suffix`。二者都替换部署默认值并解析提示词变量。完整模式仅选择渲染后的前缀进行准入；进入或退出该模式时追加通知以替代此前指令。此前系统消息保留原位置，直到压缩。默认仍启用运行时上下文。设置 `includeRuntimeContext: false` 后，当前工作目录和子代理身份等必需上下文仍保留，可选上下文被省略。

#### Token 影响

Persona 文本为其作用域中的每次请求贡献 token。初始完整模式排除其他系统段；之后的模式转换会添加通知和所选文本，而此前消息的 token 成本保留到压缩。初始空文本不贡献 token。禁用可选上下文后，必需运行时上下文仍贡献 token。

#### KV Cache 影响

渲染后的 persona 值不变时，不添加消息。变化会追加更新后的指令和通知，同时保留此前消息。提供方序列化决定该保留前缀能否复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本行何时不合适。它们是当前包约束，不是任务积压。

- **没有按提供方过滤运行时上下文的选项**——`includeRuntimeContext: false` 会抑制该作用域的所有可选贡献，但无法抑制必需贡献。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
