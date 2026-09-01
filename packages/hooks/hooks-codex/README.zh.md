---
description: "在 agent 运行期间使用你现有的 Codex hooks.json 钩子配置——阻塞提示词与工具、附加上下文或强制继续——供本桥接的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hooks-codex

[English](README.md) | 中文

## 概述

`dsh-hooks-codex` 在 agent（智能体）运行期间执行你现有 Codex 配置（`hooks.json`）中的钩子，让你已经写好的行为无需重写即可继续生效。Codex 的 5 个 hook 点会在对应时刻触发：会话开始时、提示词提交时、工具运行前后，以及运行即将停止时。钩子可以带一条模型可见的消息阻塞提示词或工具调用、向对话附加额外上下文，或强制运行继续。当你持有 Codex command 钩子、希望它们原样在 harness 中工作时选择它；没有 Codex 对应物的行为应放入原生插件。

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

挂载本包并把 `configPath` 指向你的 `hooks.json`，你已有的钩子就会在 agent 运行中的对应时刻开始触发。在第一个钩子生效之前无需其他设置。

### 何时选择

当你持有 Codex `hooks.json`、且其中的 command 钩子需要把关提示词、工具与轮次时，使用它。没有 Codex 对应物的行为请跳过它：原生插件拥有完整的 harness API，而本桥接只运行参考工具的 command hook 子集。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-hooks-codex'
  config:
    configPath: ./.codex/hooks.json
    model: deepseek-v4
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `configPath` | 必填 | Codex `hooks.json` 的路径 |
| `model` | `''` | 盖在每个 payload 上的模型名称（Codex 在每个事件中都包含 `model`） |
| `defaultTimeoutMs` | `600,000` | hook 未设置时的每 hook 超时（即 Codex 默认值） |
| `stderrSummaryMaxChars` | `500` | 持久化 `hook/result` stderr 摘要的字符上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-hooks-codex)是每个受支持字段的穷尽式真源。

### 你的钩子能做什么

| 你的钩子 | 运行时机 | 能做什么 |
|---|---|---|
| `SessionStart` | 会话开始时 | 附加该会话中模型可见的上下文 |
| `UserPromptSubmit` | agent 收到提示词时 | 阻塞提示词，或附加上下文 |
| `PreToolUse` | 工具运行前 | 阻塞工具 |
| `PostToolUse` | 工具运行后 | 带反馈阻塞结果，或附加上下文 |
| `Stop` | 运行即将停止时 | 带原因强制再执行一步 |

### 钩子如何运行与失败

- 钩子在你的项目目录（agent 的会话工作区）中运行，因此钩子里的 `pwd` 与相对路径指向你的项目，而非服务器启动目录。
- 一份配置应用于整个进程：启动时只读取一次，相对 `configPath` 从启动进程的目录解析。
- 只运行同步 command 钩子；`async: true` 或非 command 钩子会被跳过并给出警告。
- 同一事件上的钩子按配置顺序逐个运行。
- 如果配置无法读取或解析，桥接会记录警告且不运行任何钩子——agent 仍会启动。
- 运行失败的钩子（命令错误或崩溃）会被记录，agent 继续运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释桥接背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### Hook 点映射

每个受支持事件都面向一个 harness 扩展点：`SessionStart` 向新会话发射上下文（`agent/session-start`），`UserPromptSubmit` 与 `PreToolUse` 是能拒绝传入动作的 waterfall（瀑布式事件）（`agent/pre-step`、`tools/pre-execute`），`PostToolUse` 是能带反馈阻塞或向下游决策添加上下文的 waterfall（`tools/post-execute`），`Stop` 是串行监听器，其阻塞结果通过 `steer()` 强制再执行一步（`agent/turn-stopping`）。仅提供上下文的 hook 总是先通过 `next()` 委托，再把带来源的消息折叠进下游决策，因此后续监听器仍可拒绝或改写；阻塞决策映射为 `deny`（`PreToolUse` 没有 `allow` 或 `ask`）。逐事件接线位于 [`src/index.ts`](src/index.ts)。

### 载荷与环境

payload 采用 Codex 形状：snake_case，轮次事件带 `turn_id`，每个事件都带 `model` 与 `permission_mode: "default"`，stdin 写入时不带尾随换行符。工具调用的 payload 携带真实 `tool_name` 与 `tool_input: { command }` 形状（存在 `command` 参数时使用该值，否则使用 `''`），因此非 shell 工具参数不会被如实公开。基础 payload 携带 `session_id` 与 `transcript_path`；可用时后者通过 `ctx.sessionPersistence.locate(session.header)` 解析，否则为 `null`，保留 Codex `string | null` 形状——查找从不创建或 flush 产物。Codex 不进行命令替换，也不注入插件环境。

### Matcher subject 与串行执行

matcher subject 是工具名称（`PreToolUse`／`PostToolUse`）或会话源（`SessionStart`）；`UserPromptSubmit` 与 `Stop` 忽略 matcher。Codex matcher 始终是未锚定正则。匹配 hook 按配置顺序串行运行，这使每个 hook 的 `hook/invoked`／`hook/result` 对在日志中相邻，且最严格折叠与顺序无关（`deny > ask > allow`）。

### 脱离运行与释放

`SessionStart` 是唯一的 emit 点，它脱离运行——没有扩展点等待它。每条运行链都会被跟踪，对桥接执行 dispose（资源释放）时会中止仍在运行的 hook 进程，并在 dispose 完成前排空 continuation（`createDetachedRuns`，位于 `dsh-hook-protocol`）。

### 设计理念

- **兼容适配器，而非强力工具。** 桥接的存在意义是运行现有 Codex 配置中显式受支持的子集；定制行为应放在同一批扩展点上的原生插件中。
- **添加上下文不是否决。** 仅提供上下文的 hook 会先通过 `next()` 委托，再把其消息折叠进下游 enter 决策，因此后续 `agent/pre-step` 或 `tools/post-execute` 监听器仍可拒绝或改写。
- **每个失败点都受控。** 配置读取／解析失败与无效 matcher 不注册任何内容；抛异常的脱离注入会被捕获并记录，而不是破坏会话启动或循环。
- **dispose 必须达到完全停稳。** 脱离运行会被跟踪并在释放时排空，因此不会有 hook 进程或迟到回调超出 fiber 存活。
- **保持方言形状，而非最大化。** payload 保持 snake_case 并带 `turn_id`／`model`，stdin 不带尾随换行符，桥接也不实现工具前审批或改写路径——即使 harness 本可以做得更多，也保留协议的形状。

[hook-bridges Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.zh.md) 记录了桥接设计与延期缺口；[hook-protocol-lib Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-protocol-lib.zh.md) 记录了共享与逐方言的划分。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置校验、监听器注册、逐事件 payload、决策映射 |
| [`src/config.ts`](src/config.ts) | Codex 配置解析：五个受支持事件、matcher 校验、跳过原因 |
| — | 不发布运行时不变式伴生入口；`hook/*` 配对检查位于 `dsh-hook-protocol`。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享协议进入桥接设计，以及桥接所面向的扩展点。

- [hooks 组地图](../README.zh.md)——同级组页面及其包表。
- [hook 协议库](../hook-protocol/README.zh.md)——本桥接应用的共享钩子规则。
- [钩子桥接 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.zh.md)——桥接设计、决策映射与延期缺口。
- [拦截扩展点 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.zh.md)——桥接所映射的类型化 Decision 接口面。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-hooks-codex)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Hook 提供的上下文

#### 模型看到什么

`SessionStart`、已接受提示词与工具后 hook 可以添加带源归因的上下文消息；阻塞 `Stop` hook 将原因添加为下一步 steering（中途引导）。

#### Token 影响

hook 不返回上下文时没有成本。Hook 文本取决于数据，会被记录，并在后续会话请求中重发，直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已阻塞提示词或工具结果

#### 模型看到什么

提供方提供的原因逐字传递。缺失原因时，已拒绝工具变为 `Error: blocked by PreToolUse hook`，已阻塞工具后反馈精确为 `blocked by PostToolUse hook`，阻塞 stop 则精确添加 steering `continue: blocked by Stop hook`；已阻塞提示词不会产生任何模型可见消息，而是以 `blocked` 结束该轮次。Codex `systemMessage` 不会呈现。

#### Token 影响

阻塞提示词不会产生该提示词对应的模型请求 token；拒绝或反馈会添加保留的回退或提供方文本；强制 continuation 需要另一个完整请求。

#### KV Cache 影响

已阻塞提示词不发送请求，不会导致失效。拒绝、反馈与强制 continuation 上下文会追加在可复用前缀之后，不改写前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述你的 Codex 钩子目前还无法通过本桥接做到的事情，以及行为与参考工具的差异。它们是当前包约束，而非任务积压。

- **不支持的 hook 事件（Codex 当前 10 项中的 5 项）**——`PermissionRequest`、`PreCompact`、`PostCompact`、`SubagentStart` 与 `SubagentStop`。这些事件的配置会在解析期间静默丢弃。比较基线是 Codex [官方 hook 参考](https://learn.chatgpt.com/docs/hooks)。
- **`SessionStart` 只支持部分功能**——支持纯 stdout 与 JSON `additionalContext`，但 hook 脱离运行，因此上下文可能错过第一个请求。
- **`UserPromptSubmit` 只支持部分功能**——支持阻塞加纯 stdout 或 JSON 上下文，但不会强制执行通用 `systemMessage` 与 `{"continue": false}` 控制。
- **`PreToolUse` 只支持部分功能**——支持阻塞，但会忽略 `additionalContext`、`permissionDecision: "allow"` 与 `updatedInput`。每个工具都表示为 `tool_input: { command }`，因此非 shell 工具参数不会被如实公开给 hook。
- **`PostToolUse` 只支持部分功能**——支持阻塞反馈与 JSON `additionalContext`，但不会强制执行 `{"continue": false}`，非 shell 工具参数会缩减为 `{ command }`，结构化工具输出会在 `tool_response` 中展平为文本。
- **`Stop` 只支持部分功能**——阻塞会强制另一个模型轮次，但 `stop_hook_active` 始终为 `false`，`last_assistant_message` 始终为 `null`，且不会强制执行 `{"continue": false}`。因此，无条件阻塞 hook 会在每个步骤中强制 continuation，除非它自我限制。
- **通用 payload 与输出字段只支持部分功能**——每个已映射事件都报告静态配置的 `model` 与 `permission_mode: "default"`，而非当前 Codex 运行时值。`systemMessage` 会被记录 + 警告但不呈现，`{"continue": false}` 会被记录但不会应用 Codex 的事件特定停止行为。
- **配置加载与执行只支持部分功能**——一个进程级 `configPath` 会在加载时解析；尚未实现 Codex 的活动用户层、项目层、会话层、系统／托管层与插件层、信任控制以及内联 `config.toml` hook 形态。只运行同步 `command` handler，`statusMessage` 与 `commandWindows` 等当前元数据会被忽略，匹配 handler 串行运行，而非使用 Codex 的并发启动语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

上面的延期缺口就是工作队列：按会话的 hook 配置发现、会话启动投递门、stop 循环防护，以及 `continue: false` 的运行级停止。目前均无设计；官方 Codex 参考是实现其中任何一项的基线。

</details>
