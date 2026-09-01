---
description: "面向用户与维护者的工作区指令上下文说明，用于启用、设置预算或排查 AGENTS.md/CLAUDE.md 的加载与刷新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-instructions

[English](README.md) | 中文

## 概述

`dsh-agent-instructions` 将兼容 `AGENTS.md` 的工作区指令文件加载到模型上下文：用户全局文件与项目指令链作为一条持久基线进入第一次请求，成功的 `read`、`write` 或 `edit` 调用会把新出现的嵌套文件、变更与移除带入后续请求。`dsh-base` 默认包含它，profile patch 可以禁用。一切内容都受字节预算约束：较宽泛的文件先被省略，最具体的文件最后被截断，空指令链不产生任何内容。没有文件 watcher——外部编辑会在下一次成功的文件系统 touch 时，或恢复后的会话对账其基线时变得可见。

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

当 agent（智能体）需要依据工作区自身的指令文件工作时，挂载此插件。`dsh-base` 已包含它并给予 65,536 字节预算，因此基于 base 的 profile 仅在需要其他 `maxBytes` 时替换该配置行；没有文件系统提供方的树加载不到任何内容，直到提供方出现。

### agent 获得的内容

第一次请求包含一条持久基线消息：先是用户全局 `$DSH_HOME/AGENTS.md`，再按从宽泛到具体的顺序包含项目指令链——从项目根目录到会话工作目录的每个目录中所有现有候选文件。去除空白后内容一致的同级文件只渲染一次，因此复制了 `AGENTS.md` 的 `CLAUDE.md` 不会被重复加载。当成功的 `read`、`write` 或 `edit` 调用到达更深的目录后，下一次请求会包含新适用的指令文件；已改变的文件会替换其内容，消失或成为较早候选文件重复项的文件会产生移除通知。

### 配置

默认设置适合典型检出：`.git` 标记项目根目录，`AGENTS.md` 与 `CLAUDE.md` 是基础候选，`AGENTS.local.md` 与 `CLAUDE.local.md` 是叠加的本地 overlay。只有 `maxBytes` 必填——它限制完整渲染后的基线，让每个部署显式选择自己的提示词预算。

```yaml
- name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

受支持的字段一览：

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  maxBytes: number
  maxSourceBytes?: number
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 完整渲染基线消息的上限，单位为字节 |
| `maxSourceBytes` | `1048576` | 渲染前单个源指令文件的上限 |
| `projectRootMarkers` | `['.git']` | 标记项目根目录的目录名 |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | 每个项目目录中加载的基础文件名 |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | 在基础文件之后加载的本地 overlay 文件名 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 存放用户全局 `AGENTS.md` 的目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-instructions)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 观察预算

渲染会优先保留最具体的文件：先丢弃完整的较宽泛文件，再截断最具体的文件，并发出可见的 `Workspace instruction budget ...` 通知，指名被省略与被截断的路径。渲染后的字节数绝不超过 `maxBytes`。超出预算的宽泛文件会被忽略；刷新期间它被视为暂时不可用，而非被移除。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件背后的设计决策；可观察行为见[使用本包](#use-this-package)。

### 设计理念

该插件建立在一个原则上：工作区指令是持久的对话内容，按 agent 与会话分别归属。基线消息与刷新消息都是普通的带来源 `user/message` 事件，因此与其他历史一样可回放、可压缩、可恢复，模型可见状态总能从会话日志重建。插件拥有完整的 `<system-reminder>` 框架，每条注入消息都原样到达模型。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器、`tools/result` touch 跟踪、inbox 组合 |
| [`src/config.ts`](src/config.ts) | `Config` schema、预算解析、基线标识 |
| [`src/files.ts`](src/files.ts) | 候选发现、项目根搜索、有界流式读取 |
| [`src/render.ts`](src/render.ts) | 指令渲染、预算截断、变更记录 |
| [`src/state.ts`](src/state.ts) | 持久消息来源、版本／digest 缓存、对账 |
| [`src/digest.ts`](src/digest.ts) | SHA-1 内容标识与每目录重复键 |
| — | 不发布运行时不变式伴生入口；回放会容忍未知或格式错误的 workspace source，私有 pending/cache 状态转换由聚焦 pipeline 测试覆盖。 |

### 主要流程

在会话第一次符合条件的 `agent/pre-step`，插件组合基线并把它折入进入步骤的批次、紧随已领取的消息之后。成功的第一方 `read`、`write`、`edit` 调用贡献的 touch 会沿父级执行 token 逐层上浮；当外层步骤进入持久历史后，一次投影会把可见会话状态与 inbox 对账，并排入新增、替换或移除。路径与 digest 都未变的内容绝不重复注入。发现跟随结构化文件系统活动，而非 shell 导航，因为每次本地 shell 调用都启动新进程，解析任意 shell 语法不是可靠的文件系统 seam。

### 不变式

每条注入消息都携带带类型的来源及其变更列表；完整基线还携带从规范化发现、优先级、项目根与预算配置派生的标识，匹配的持久消息会确认已排队的基线。模型可见文本不含隐藏状态标记，指令内容或模型可见元数据中的字面 `</system-reminder>` 文本都会被转义，因此仓库控制的文本无法关闭插件控制的框架。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从指令文件格式逐步进入设计决策与穷尽式配置。

- [文档标准](../../../docs/AGENTS.md)——`AGENTS.md` 指令文件包含什么、如何维护。
- [工作区上下文决策记录](../../../.agents/notes/implemented/feature/2026-06-24-workspace-context.zh.md)——按 agent／会话隔离与生命周期理由。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-instructions)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a> <a id="prompt-shape"></a>
## 模型体验

### 基线上下文

#### 模型看到的内容

第一次请求的派生历史中包含一条持久 user 角色消息，其中按从宽泛到具体的顺序包含有界用户全局指令与项目指令链。可见基线兼容时，恢复会复用该消息。

##### 基线指令模板

```markdown
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

<user-global-instructions>

Instructions from: AGENTS.md

<project-instructions>
</system-reminder>
```

#### Token 影响

渲染后基线只追加一次，并保留在派生历史中直到压缩。`maxBytes` 限制完整消息，较宽泛文件在最具体文件截断之前被省略，空指令链不产生 token。

#### KV Cache 影响

仅追加，位于现有可复用前缀之后。可见基线标识兼容时，恢复会保持复用；不兼容的标识会追加一条完整替代基线，因此发现、优先级、项目根或预算变更只会从该历史位置起影响复用。

### 新发现的 scope 上下文

#### 模型看到的内容

成功的第一方文件系统调用到达更深目录后，下一次请求会包含一条保留的带来源 `user/message`，其中包含新适用的指令文件。

##### 附加指令模板

```markdown
<system-reminder>
Additional instructions from: packages/app/AGENTS.md

These instructions apply to work under `packages/app`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

<nested-instructions>
</system-reminder>
```

#### Token 影响

每个已发现 scope 都会添加有界历史 token，直到压缩。可见会话状态与版本／digest 比较会抑制未更改内容，PTC mode 将同一消息延迟至外层 `run_code` 结果及其所属持久步骤之后。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 已改变或移除的指令上下文

#### 模型看到的内容

已改变的文件会产生 `Updated instructions from: <path>` 加替换内容。消失或成为同一目录中较早候选文件重复项的候选文件会产生下方移除通知。

##### 移除通知

```markdown
<system-reminder>
Instructions removed: packages/app/AGENTS.md

The previously loaded instructions from this file no longer apply.
</system-reminder>
```

#### Token 影响

每项已确认变更或移除都是一条受 `maxBytes` 限制的保留历史消息。提供方失败不添加消息，预算省略的更新仍可在后续文件系统 touch 中处理。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明指令加载何时不合适或需要运维注意。它们是当前包约束，不是任务积压。

- **发现跟随结构化 fs 工具，而非 shell 导航**：更改目录的 `bash` 命令不会触发嵌套指令发现，因为 shell 语法与每次调用的 shell 状态不是可靠的文件系统 seam。
- **刷新由 touch 驱动**：没有 watcher；外部编辑会在下一次成功的第一方 `read`、`write` 或 `edit` 时、恢复对账可见基线时，或进入步骤的 pre-step 恢复被遮蔽基线时可见。
- **候选语义有意保持简单**：不解释小写名称、`.claude/rules/` 与 `@path` import；项目 scope 默认加载 `AGENTS.local.md`／`CLAUDE.local.md` overlay，但用户全局 `$DSH_HOME` scope 没有本地 overlay，其他自定义名称需要显式候选配置。
- **每目录去重基于内容**：同级候选只有在去除首尾空白后字节完全一致时才折叠。`CLAUDE.md` 若 symlink 到同级 `AGENTS.md`，会解析为相同内容并像任何重复项一样折叠；从 `AGENTS.md` 漂移的独立副本则会与它一起完整加载。
- **Symlink 指令文件会跨越信任边界跟随**：最终组件是 symlink 的候选文件会被解析并加载其目标，因此克隆仓库可以将树外文件内容呈现为较低优先级的工作区指引（它绝不覆盖 system、developer 或用户直接下达的指令）。加载不受信任仓库时，请用文件系统策略门禁或 OS 沙箱限制 `ctx.fs`。
- **指令内容受限但不会被摘要**：超出预算的宽泛文件会被省略，最具体文件可能被截断；该插件绝不请求模型压缩指令文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
