---
description: "面向组合、配置或排查跨执行能力文件效果策略的用户与维护者的共享逐调用沙箱策略解析器与当前模型上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-policy

[English](README.md) | 中文

## 概述

`dsh-sandbox-policy` 为每次受限能力调用从统一的策略归属位置解析文件效果模式与工作区根目录，并在每次请求前把当前策略告知模型。部署方设置默认模式与回退工作区根目录；会话可以切换自己的模式，切换因存在于会话日志中而跨重启保留。每个强制执行能力——bash、文件系统、终端——读取同一份解析出的策略，因此调用运行的模式绝不取决于由哪个家族解析。模型会看到一条简洁的 `sandbox:policy` 贡献，指明模式与工作区，而不会收到一份已挂载能力的清单。

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

在任何运行沙箱强制执行能力的组合中挂载此包：它拥有这些能力消费的部署默认值与逐会话覆盖，并把当前策略贡献给模型的运行时上下文快照。

### 何时选择

为每个带受限能力（bash、文件系统、终端）的组合选择它，让单一策略归属位置防止它们漂移到不同的模式或工作区根目录。只有没有任何沙箱策略强制执行时才跳过它——没有消费方时，解析出的策略不起作用。

### 最小配置

用默认模式加载本包；故障安全默认值是 `read-only`，想要可写工作区 agent 的部署需要显式选择 `workspace-write`。

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: /absolute/path/to/workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `read-only` | 会话起始的部署默认模式，加载时验证 |
| `workspaceRoot` | `process.cwd()` | 无 agent（智能体）调用或没有 cwd 的会话在 `workspace-write` 下可写入的回退根目录；普通 agent 调用改用会话的不可变 cwd |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sandbox-policy)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 切换会话模式

会话的模式可以在运行时通过 UI 策略控件或显式切换来更改；切换记录在会话日志中，并在该会话的下一次受限调用时生效。切换通过回放跨重启保留，每个会话保持自己的模式——两个会话绝不会看到彼此状态。切换后的会话继续以不可变的工作区 cwd 作为写入边界。

### 失败与恢复

无效的配置模式会在插件加载时被拒绝，因此拼写错误会大声失败，而不是静默改变策略。没有 cwd 的会话与无 agent 调用回退到配置的工作区根目录；带已批准显式模式的调用只在该次调用中使用该模式。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释策略解析、逐会话存储与模型可见贡献；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 解析优先级

`resolve({ session, mode })` 返回一份完整的逐调用策略：已批准的显式模式优先于会话最后一条 `sandbox/mode` 事件，后者又优先于部署默认值。会话的不可变 `cwd` 先按文件系统语义规范化，再成为工作区根目录，因此 `symlink/..` 与进程工作目录解析一致；否则使用配置的回退值。

### 逐会话存储

运行时切换是在对应会话日志中追加的一条仅记录 `sandbox/mode` 事件——切换本身就是事件，任何机制都不会在带外修改模式状态。`effective = explicit grant ?? fold(events) ?? deployment default`，因此覆盖通过回放跨重启保留，两个会话也绝不会看到彼此状态。工作区标识无需事件：创建时记录的不可变 `SessionHeader.cwd` 是该会话每次调用使用的根。事件仍只进入日志；在每次请求前，归属方会把当前事实贡献给完整运行时上下文快照，agent loop（智能体循环）将该快照记录为一条带来源的 `user/message`。

### 模型可见文本

`sandbox:policy` 贡献说明模式的与具体能力无关的文件操作约定，以及 `workspace-write` 下规范化的会话工作区。它不枚举已挂载能力；工具插件保留特定于操作的拒绝与升权引导，批准策略单独贡献给同一份快照，计划引导仍由 `dsh-plan-mode` 的系统段落管理。可选的 `./invariant` 配套组件会拒绝值超出封闭模式词汇的伪造持久 `sandbox/mode` 事件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SandboxPolicyService`、`Config` schema、策略解析与上下文贡献 |
| [`src/session-mode.ts`](src/session-mode.ts) | `sandbox/mode` 事件、其 fold 与写入路径 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：拒绝超出封闭词汇的 `sandbox/mode` 值 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

先从子系统参考文档了解共享词汇，再看 seam 约定与跨家族决策。

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——模式、逐调用策略与强制执行语义。
- [沙箱 seam 包](../sandbox/README.zh.md)——每个强制执行能力实现的隔离约定。
- [跨家族文件沙箱决策](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.zh.md)——为何存在统一的共享策略归属位置。

-----

<a id="model-experience"></a>
## 模型体验

### 当前文件沙箱策略

#### 模型看到什么

每个 agent 会话的当前运行时上下文快照中都有一项 `sandbox:policy` 贡献。它不枚举已挂载的能力。工具插件继续负责操作与升权引导，批准策略单独贡献给同一份快照，计划引导仍由 `dsh-plan-mode` 的系统段落管理。

##### 只读

```markdown
Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.
```

##### 工作区写入

```markdown
Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "<workspace root>". Some platform temporary areas may also be writable.
```

##### 完全访问

```markdown
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.
```

#### Token 影响

首次请求和有效策略每次变化时增加一条简洁的持久上下文消息；未变化的请求不增加内容。`workspace-write` 只携带规范化的会话工作区路径；平台特定的临时路径会以摘要表述，不会加入依赖主机的字节。

#### KV Cache 影响

模式切换时，稳定的系统提示词仍逐字节相同。变化后的完整上下文快照会追加到保留的历史之后，从而保留此前已缓存的前缀；后续未变化的请求会复用该保留快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了本包提供的策略表面。它们是当前包约束，不是通用沙箱对比或任务积压。

- **每个会话只有一个主要工作区根目录**——策略解析 `SessionHeader.cwd`；额外可写根目录不属于 `SandboxExecutionPolicy`。
- **仅限文件操作模式**——`SandboxMode` 管控文件操作；网络和进程策略不在其词汇中，因此这里没有限制它们的旋钮。
- **有意概述临时区域**——强制执行后端会授予不同的平台临时区域，这些区域在策略解析后才会选定，因此无法在当前上下文中如实枚举。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
