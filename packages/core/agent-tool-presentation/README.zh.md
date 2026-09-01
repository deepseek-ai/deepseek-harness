---
description: "面向用户与维护者的 agent 平面呈现选择器说明，用于选择、配置或调试 agent preset 的模型看到其工具的哪种形态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-tool-presentation

[English](README.md) | 中文

## 概述

[agent preset](../../preset/agent-presets/README.zh.md) 携带 `dsh-agent-tool-presentation`，用来声明「模型看到其工具的哪一种形态」：`native`（每个可见 schema）、`ptc`（只有 `run_code` 加一份生成的 SDK）或 `both`。工具注册表本身仍在宿主平面——这一行只声明挂载 agent 的呈现方式，因此一个 PTC mode 会话可以与多个 native 会话同进程并存，各自看到各自的目录。PTC 模式在挂载前会等待代码运行时，因此针对未组装运行时的部署选择 PTC mode 的 preset 会在挂载时失败，而不是在第一次请求时失败。`mode` 字段是必填的：不带这一行的 preset 本来就会拿到部署默认值。当 agent preset 需要固定其 agent 的模型所看到的工具形态时，请选择本包。

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

把这一行加入 agent preset，以固定每个加入该 preset 的 agent 看到其工具的方式。`native` 以函数定义的形式呈现每个可见工具 schema；`ptc` 只呈现 `run_code` 传输、一份生成的 SDK 以及「只有 `run_code` 可被直接调用」这条规则；`both` 同时呈现两种形态。未作声明的 agent 会拿到 [`dsh-tools`](../tools/README.zh.md) 那一行上的部署级 `mode`。

### 把这一行加入 preset

```yaml
- name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: ptc
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | 必填 | `native`——每个 schema；`ptc`——`run_code` 加生成 SDK；`both`——两种形态 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-tool-presentation)是每个受支持字段的穷尽式真源。`mode` 是必填而非有默认值，因为不带这一行的 preset 会继承部署默认值。

### PTC 模式需要什么

选择 `ptc` 或 `both` 需要已组合的代码运行时（`ctx.codeRuntime`），且其语言有已注册的 SDK 渲染器——TypeScript 运行时经 [`dsh-code-runtime-worker-thread`](../../code-runtime/code-runtime-worker-thread/README.zh.md) 交付，TypeScript 与 Python 的 SDK 渲染器都内置在 `dsh-tools` 中。针对未组装此类运行时的部署选择 PTC 模式的 preset 会拒绝挂载并点名这一行，使失败落在操作者可以行动的地方，而不是落在会话的第一次请求上。

### 每个 agent 只声明一次呈现方式

一个 agent 只声明一次呈现方式。同一份组装里的第二次声明会被拒绝而不是合并：对「模型看到哪种形态」给出两个答案是矛盾，不是覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

工具注册表搬不进 preset：它的消费者全在宿主平面——agent loop 读它的调度器，API proxy 读它的 presenter，每个工具插件都往里注册——而一个服务只有在所有消费者一起下沉时才能下沉。preset 能拥有的是这份注册表的呈现方式。`ctx.tools.presentAs()` 为挂载作用域声明它，而挂载作用域就是 preset 的常驻挂载，因此该声明覆盖每个加入该 preset 的 agent，一个 PTC mode preset 可以与多个 native 会话同进程并存。每个组合一行，而不是每个会话一行。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`mode` 配置、把 `ctx.tools.presentAs` 接到挂载作用域的 `apply` |
| — | 不发布运行时不变式伴生入口；本包只对 `ctx.tools` 发起一次 scoped 调用，不持有事件或快照；所选 presentation 的关系由 tool registry 持有并由 `dsh-tools` 观察。 |

### 行为说明

`native` 立即生效。PTC 模式则等待 `ctx.codeRuntime`——这是一个宿主平面服务：针对未组装运行时的部署选择 PTC mode 的 preset 会让这一行停在 pending，`dsh-agent-presets` 会指名此 id 拒绝挂载。`presentAs` 本身就是 effect，因此该声明随这一行撤销，无需第二个包装层拥有它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [tools 包](../tools/README.zh.md)——工具呈现模式与 `presentAs` API。
- [agent-presets 包](../../preset/agent-presets/README.zh.md)——preset 如何组合 agent 及其常驻挂载。
- [code-runtime worker-thread 包](../../code-runtime/code-runtime-worker-thread/README.zh.md)——PTC 模式所需的 TypeScript 运行时。
- [PTC mode 执行器塌缩 note](../../../.agents/notes/implemented/bug-fix/2026-08-07-ptc-executor-collapse.zh.md)——通告面与可调用面为何保持一致。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

通过在 `dsh-tools` 中选择的工具呈现方式间接影响——这一行只在 `dsh-tools` 拥有的两种投影之间选择，本身不注册任何提示词、schema 或结果。

#### KV Cache 影响

没有直接的失效影响；呈现方式在 agent 组装时即固定，因此其请求前缀在该会话的整个生命周期内保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明这一行何时需要特别留意。它们是当前包约束，不是任务积压。

- **运行时仍在宿主平面**——preset 可以选择 PTC mode，却无法自带它所需的 TypeScript 运行时；未组装运行时的部署也就无法组装任何 PTC 模式的 preset。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
