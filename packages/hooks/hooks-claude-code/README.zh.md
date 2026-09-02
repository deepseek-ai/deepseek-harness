---
description: "在 agent 运行期间使用你现有的 Claude Code hooks.json 或 settings 钩子配置——阻塞提示词与工具、附加上下文或强制继续——供本桥接的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hooks-claude-code

[English](README.md) | 中文

## 概述

`dsh-hooks-claude-code` 在 agent（智能体）运行期间执行你现有 Claude Code 配置（`hooks.json` 或 settings 文件的 `hooks` key）中的钩子，让你已经写好的行为无需重写即可继续生效。你的钩子会在对应时刻触发：会话开始时、提示词提交时、工具运行前后、运行即将停止时，以及子 agent 启动或结束时。钩子可以带一条模型可见的消息阻塞提示词或工具调用、向对话附加额外上下文，或强制运行继续。当你持有 Claude Code command 钩子、希望它们原样在 harness 中工作时选择它；没有 Claude Code 对应物的行为应放入原生插件。

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

挂载本包并把 `configPath` 指向你的钩子配置，你已有的钩子就会在 agent 运行中的对应时刻开始触发。在第一个钩子生效之前无需其他设置。

### 何时选择

当你持有 Claude Code `hooks.json`（或 `hooks` key 存放配置的 settings 文件）、且其中的 command 钩子需要把关提示词、工具与轮次时，使用它。没有 Claude Code 对应物的行为请跳过它：原生插件拥有完整的 harness API，而本桥接只运行参考工具的 command hook 子集。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `configPath` | 必填 | `hooks.json` 或 `hooks` key 存放配置的 settings 文件路径 |
| `pluginRoot` | — | 替换命令字符串中的 `${CLAUDE_PLUGIN_ROOT}` |
| `projectDir` | 会话工作区 | 替换 `${CLAUDE_PROJECT_DIR}` 并设置 `CLAUDE_PROJECT_DIR` 环境变量 |
| `defaultTimeoutMs` | `600,000` | hook 未设置时的每 hook 超时（即 Claude Code 默认值） |
| `stderrSummaryMaxChars` | `500` | 持久化 `hook/result` stderr 摘要的字符上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-hooks-claude-code)是每个受支持字段的穷尽式真源。

### 你的钩子能做什么

| 你的钩子 | 运行时机 | 能做什么 |
|---|---|---|
| `SessionStart` | 会话开始时 | 附加该会话中模型可见的上下文 |
| `UserPromptSubmit` | agent 收到提示词时 | 阻塞提示词，或附加上下文 |
| `PreToolUse` | 工具运行前 | 阻塞工具，或在运行前请求批准 |
| `PostToolUse` | 工具运行后 | 带反馈阻塞结果，或附加上下文 |
| `Stop` | 运行即将停止时 | 带原因强制再执行一步 |
| `SubagentStart` | 子 agent 启动时 | 向仍在运行的子 agent 附加上下文（仅限同进程） |
| `SubagentStop` | 子 agent 结束时 | 只观测——不能阻塞或添加上下文 |

### 钩子如何运行与失败

- 钩子在你的项目目录（agent 的会话工作区）中运行，因此钩子里的 `pwd` 与相对路径指向你的项目，而非服务器启动目录。
- 命令字符串中的 `${CLAUDE_PLUGIN_ROOT}` 与 `${CLAUDE_PROJECT_DIR}` 会按你的配置替换，且每个钩子进程都会设置 `CLAUDE_PROJECT_DIR`。
- 一份配置应用于整个进程：启动时只读取一次，相对 `configPath` 从启动进程的目录解析。
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

每个受支持事件都面向一个 harness 扩展点：`SessionStart` 向新会话发射上下文（`agent/session-start`），`UserPromptSubmit` 与 `PreToolUse` 是能拒绝传入动作的 waterfall（瀑布式事件）（`agent/pre-step`、`tools/pre-execute`），`PostToolUse` 是能带反馈阻塞或向下游决策添加上下文的 waterfall（`tools/post-execute`），`Stop` 是串行监听器，其阻塞结果通过 `steer()` 强制再执行一步（`agent/turn-stopping`）。两个 subagent 事件面向 child 生命周期发射（`subagent/start`、`subagent/end`）：start 向仍在运行的同进程 child 注入上下文，stop 只观测。仅提供上下文的 hook 总是先通过 `next()` 委托，再把带来源的消息折叠进下游决策，因此后续监听器仍可拒绝或改写；阻塞决策映射为 `deny`（`PreToolUse` 为 `ask`）。逐事件接线位于 [`src/index.ts`](src/index.ts)。

### 载荷与环境

桥接从 `session_id`、字符串形态的 `transcript_path`、`cwd` 与 `hook_event_name` 的基础字段加逐事件字段构建每个事件的 stdin payload。`transcript_path` 出于兼容性保留在 payload 中，但始终为 `''`：持久化 seam 不暴露产物路径，且默认 zstd 压缩的会话日志无法被 hook 脚本读取。省略 `projectDir` 时，`CLAUDE_PROJECT_DIR` 按次默认到会话工作区，与钩子运行的目录一致；`${CLAUDE_PLUGIN_ROOT}` 与 `${CLAUDE_PROJECT_DIR}` 替换在配置解析时进行。

### Matcher subject 与串行执行

matcher subject 是工具名称（`PreToolUse`／`PostToolUse`）、会话源（`SessionStart`），或常量 `agent_type` `general-purpose`（`SubagentStart`／`SubagentStop`——subagent seam 不携带每 kind 标签）；`UserPromptSubmit` 与 `Stop` 忽略 matcher。匹配 hook 按配置顺序串行运行，这使每个 hook 的 `hook/invoked`／`hook/result` 对在日志中相邻，且最严格折叠与顺序无关（`deny > ask > allow`）。

### 脱离运行与释放

三个 emit 点（`SessionStart`、`SubagentStart`、`SubagentStop`）以脱离方式运行——没有扩展点等待它们。每条运行链都会被跟踪，对桥接执行 dispose（资源释放）时会中止仍在运行的 hook 进程，并在 dispose 完成前排空 continuation（`createDetachedRuns`，位于 `dsh-hook-protocol`）。

### 设计理念

- **兼容适配器，而非强力工具。** 桥接的存在意义是运行现有 Claude Code 配置中显式受支持的 command hook 子集；定制行为应放在同一批扩展点上的原生插件中。
- **添加上下文不是否决。** 仅提供上下文的 hook 会先通过 `next()` 委托，再把其消息折叠进下游 enter 决策，因此后续 `agent/pre-step` 或 `tools/post-execute` 监听器仍可拒绝或改写。
- **每个失败点都受控。** 配置读取／解析失败与无效 matcher 不注册任何内容；抛异常的脱离注入会被捕获并记录，而不是破坏会话启动或循环。
- **dispose 必须达到完全停稳。** 脱离运行会被跟踪并在释放时排空，因此不会有 hook 进程或迟到回调超出 fiber 存活。
- **串行而非并发。** 匹配 hook 按配置顺序串行运行：每个 `hook/invoked`／`hook/result` 对在日志中保持相邻，且决策折叠与顺序无关，因此结果与参考引擎的并发启动一致，代价是串行化的延迟。

[hook-bridges Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.zh.md) 记录了桥接设计与延期缺口；[hook-protocol-lib Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-hook-protocol-lib.zh.md) 记录了共享与逐方言的划分。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置校验、监听器注册、逐事件 payload、决策映射 |
| [`src/config.ts`](src/config.ts) | Claude Code 配置解析：受支持事件、matcher 校验、命令替换 |
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
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-hooks-claude-code)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Hook 提供的上下文

#### 模型看到什么

`SessionStart`、已接受提示词、工具后与实时同进程 subagent-start hook 可以添加带源归因的上下文消息；阻塞 `Stop` hook 将原因添加为下一步 steering（中途引导）。远程 child 注入没有本地目标。

#### Token 影响

hook 不返回上下文时没有成本。Hook 文本取决于数据，会被记录，并在后续会话请求中重发，直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已阻塞提示词或工具结果

#### 模型看到什么

提供方提供的原因逐字传递。缺失原因时，已拒绝工具变为 `Error: blocked by PreToolUse hook`，已阻塞工具后反馈精确为 `blocked by PostToolUse hook`，阻塞 stop 则精确添加 steering `continue: blocked by Stop hook`；已阻塞提示词不会产生任何模型可见消息，而是以 `blocked` 结束该轮次。`systemMessage` 与 `updatedInput` 会被记录或警告，但在此实现中对模型不可见。

#### Token 影响

阻塞提示词不会产生该提示词对应的模型请求 token；拒绝或反馈会添加保留的回退或提供方文本；强制 continuation 需要另一个完整请求。

#### KV Cache 影响

已阻塞提示词不发送请求，不会导致失效。拒绝、反馈与强制 continuation 上下文会追加在可复用前缀之后，不改写前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述你的 Claude Code 钩子目前还无法通过本桥接做到的事情，以及行为与参考工具的差异。它们是当前包约束，而非任务积压。

- **不支持的 hook 事件（Claude Code 当前 30 项中的 23 项）**——`Setup`、`InstructionsLoaded`、`UserPromptExpansion`、`MessageDisplay`、`PermissionRequest`、`PostToolUseFailure`、`PostToolBatch`、`PermissionDenied`、`Notification`、`TaskCreated`、`TaskCompleted`、`StopFailure`、`TeammateIdle`、`ConfigChange`、`CwdChanged`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove`、`PreCompact`、`PostCompact`、`SessionEnd`、`Elicitation` 与 `ElicitationResult`。这些事件的配置会在配置组解析前被忽略，因此不支持的事件既不会使配置失效，也不会注册 hook。比较基线是 Claude Code [官方 hook 事件参考](https://code.claude.com/docs/en/hooks#hook-events)。
- **`SessionStart` 只支持部分功能**——会消费 JSON `additionalContext`，但不支持纯 stdout 上下文、`initialUserMessage`、`sessionTitle`、`watchPaths`、`reloadSkills` 与 `CLAUDE_ENV_FILE`。hook 脱离运行，因此上下文可能错过第一个请求，payload 会省略 `model`、`agent_type` 与 `session_title` 等可选字段。
- **`UserPromptSubmit` 只支持部分功能**——支持阻塞与 JSON `additionalContext`，但不支持纯 stdout 上下文、`sessionTitle` 与 `suppressOriginalPrompt`。除非被覆盖，否则桥接还会使用自身 600 秒默认值，而非 Claude Code 的事件特定 30 秒 command 超时。
- **`PreToolUse` 只支持部分功能**——`deny` 与 `ask` 决策可用；`allow` 不会预审批，`defer` 不受支持，`additionalContext` 会被忽略，`updatedInput` 会被记录 + 警告但不应用（见 [pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.zh.md)）。
- **`PostToolUse` 只支持部分功能**——支持阻塞反馈与 JSON `additionalContext`，但不支持 `updatedToolOutput` 与 `updatedMCPToolOutput`，`tool_response` 会展平为文本。
- **`SubagentStart` 与 `SubagentStop` 只支持部分功能**——两者均报告常量 `agent_type` `general-purpose`，并在 Claude Code 报告父会话的位置使用 child 会话 id。Start 上下文是尽力而为，且只能到达仍在运行的同进程 child；stop 只观测，无法阻塞 subagent 或向其提供上下文。Stop 省略 `agent_transcript_path`、`last_assistant_message`、`background_tasks` 与 `session_crons`，并始终报告 `stop_hook_active: false`。
- **`Stop` 只支持部分功能**——阻塞会强制另一个模型轮次，但 `stop_hook_active` 始终为 `false`，会省略 `last_assistant_message`、`background_tasks` 与 `session_crons`，且未实现连续阻塞上限。因此，无条件阻塞 hook 会在每个步骤中强制 continuation，除非它自我限制。
- **通用 payload 与输出字段只支持部分功能**——已映射事件会省略 Claude Code 原本会提供的 `prompt_id`、`permission_mode` 与 `effort`，且 `transcript_path` 永不填充：它始终为空字符串，因为持久化 seam 不暴露产物路径，且默认 zstd 压缩的会话日志无法被 hook 脚本读取。`systemMessage` 会被记录 + 警告但不呈现；`{"continue": false}` 会被记录但不会停止运行；`suppressOutput`、`stopReason` 与 `terminalSequence` 不会被应用。
- **Handler 与配置只支持部分功能**——只运行 shell 形态 command handler。会跳过 `http`、`mcp_tool`、`prompt` 与 `agent` handler；`args`、`async`、`asyncRewake`、`shell`、`if`、`once` 与 `statusMessage` 等 command handler 选项不会被遵循。匹配 handler 串行运行且不去重，而 Claude Code 会并行运行并对相同 handler 去重。一个进程级 `configPath` 会在加载时解析一次；尚未实现 Claude Code 的分层项目、用户、插件与策略发现以及实时重新加载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

上面的延期缺口就是工作队列：按会话的 hook 配置发现、会话启动投递门、stop 循环防护，以及 `continue: false` 的运行级停止。目前均无设计；官方 Claude Code 参考是实现其中任何一项的基线。

</details>
