# Agent Note: Headless 的机器可读运行接口

Status: implemented

[English](2026-09-09-headless-machine-readable-run-surface.md) | 中文

## 问题

`dsh --profile headless` 面向的是人类终端：任务只能通过 argv 传入，stdout 只输出最终一条助手消息，provider 的推理过程流式写到 stderr，而且每次运行都新建一个随机会话。[Headless is a direct core entry point](../../archived/architecture/2026-08-09-headless-direct-core-entry-point.md) 拥有那套传输与完成契约；[headless reasoning progress](../../archived/feature/2026-08-21-headless-reasoning-progress.md) 拥有 stderr 投影。

一个"每次唤醒起一个 headless 进程"的监督进程（例如外部 agent 运行时）需要三样该契约没有提供的东西。它需要通过私有管道而不是 argv 传入任务，因为长提示词会超出参数上限，而 argv 对其他进程可见。它需要一条机器可读的流，把助手文本、推理、工具调用与结果、轮次边界和用量区分开，因为抓取 stderr 只能拿到推理，而 stdout 最后一行拿不到任何工具活动。它需要一个精确的会话身份，以便在下一次唤醒时传回去，因为每次进程都新建随机会话意味着无法连续。

## 决策

`dsh-headless` bundle 拥有一个可选的机器可读运行接口。默认调用保持原有契约不变：stdout 输出一条最终助手消息，推理走 stderr，当且仅当终端 `turn/end` 原因为 `completed` 时退出码为 0。

三项新增扩展 [Apps own their command lines](../../archived/architecture/2026-08-06-app-owned-command-line.md) 确立的 app 自有命令行：

- `--json` 把 stdout 负载换成逐行 JSON 运行事件。推理变成一条事件而不再写 stderr，因此该模式下 stderr 只承载 `dsh:` 诊断。
- `--session-id <id>` 选定精确的会话身份：采用具有该 id 的持久化会话，不存在时就失败。不带该 flag 时，运行仍像以前一样生成 `session-<uuid>`。
- 没有位置参数、或者位置参数为 `-` 时，任务文本改从 stdin 读取。

每次运行的 `--model` 覆盖被明确排除在范围之外；组合默认模型仍然权威。

产品改动限于 `packages/bundle/headless`：`src/startup.ts`、`src/index.ts`、新增的 `src/json-stream.ts`、包清单与 `tsconfig.json`，以及测试。围绕它，产品 profile 的期望测试位于 `apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts`，端到端覆盖两种输出模式，并给 `packages/test-support/loader-smoke` harness 增加了一个可选的调用方自有 `cwd`，让两次唤醒共享同一个世界；`scripts/check-workspace-constraints.ts` 与包清单负责发布两个入口共同引用的共享 chunk `lib/json-stream-*.js`，`pnpm-lock.yaml` 则记录新增的 `@deepseek-ai/dsh-session-query` workspace 链接。不修改任何 core session、持久化、session-controller、base 组合或 launcher 文件。

### 命令行契约

```text
dsh --profile headless [--json] [--session-id <id>] [<task>... | -]
```

任务解析顺序：拼接后的位置参数，其次是 `-`，其次是管道 stdin。只有空白的位置参数本身就属于用法错误，即使 stdin 不是终端也一样，因此误传的空白参数绝不会消费管道内容；完全缺失任务时，仅在 stdin 是终端时属于用法错误。单独的 `-` 是唯一的 stdin 标记：把它与其他任务词混用属于用法错误，而不是以连字符开头的任务。管道任务会原样发送，包括结尾换行。在 `--json` 模式下，所有用法错误——包括 commander 自身的语法拒绝，例如未知选项或选项缺少取值——都会在进程退出前写出 `error` 事件，因为 runner 从未挂载来写它；事件 message 省略 commander 的 `error: ` 前缀，使同一事件类型只承载一种消息形态。

`--json` 只改变 stdout 负载和推理投影的去向。退出码、关闭顺序、会话 flush 和持久化会话日志都不变，因此监督进程对一次运行的分类方式与现在完全一致。

### 事件流

`--json` 向 stdout 每行写一个 JSON 对象，不写其他内容。词汇表是会话事件日志的投影，而不是日志本身。

| `type` | 字段 | 发出时机 |
|---|---|---|
| `session` | `sessionId`、`cwd` | 第一行，先于任何模型输出 |
| `status` | `phase`（`turn_start`、`step_start`、`step_end`、`turn_end`）、`turn`、`step`、`usage`、`reason` | 每个边界一条 |
| `text` | `text` | 一个已提交的助手文本块 |
| `thinking` | `text` | 一个已提交的推理块 |
| `tool_call` | `callId`、`tool`、`input` | 每次调用一条 |
| `tool_result` | `callId`、`status`、`result` | 每次追加的结果一条 |
| `error` | `message` | runner 在轮次之外抛出的失败 |
| `final` | `text` | 最后一行 |

投影规则：

- 文本与推理只从已提交的 `assistant/message` 投影，绝不来自实时的 attempt 增量。被重试或丢弃的 attempt 会追加 `assistant/attempt`，投影直接忽略，因此事件流永远不会承载持久化日志中不存在的内容（[只在提交点发布状态](../../../../packages/AGENTS.md)）。
- 每个已提交的内容块按内容顺序变成恰好一条 `text` 或 `thinking` 事件；`tool-call` 块不投影，因为 `tool/call` 事件已经拥有它。`user/message` 回显和内部会话事件（标题、模型选择、投影、检查点、目标、子 agent）都不投影。
- `tool/result` 仅在其 `surfaceOp` 为 `append` 时投影。压缩对旧结果的替换属于历史，投影它会产生没有对应 `tool_call` 的 call id。
- 每个被投影的字符串与对象键都限制在 8 KiB；被截断的事件带 `truncated: true`，单条序列化事件行（含换行）限制在 32 KiB——超长事件保留标量字段、丢弃结构化字段，极端情况下只剩 `type` 与 `truncated`，嵌套达到 64 层及以上的负载会在该深度被截断，因此任何合法输入都不会让限界递归溢出。进程级 `error` 事件同样受限；字面量 `__proto__` 参数键会作为数据复制，而不经过继承的 setter；空工具参数字符串会投影为 `{}`，与执行器保持一致；JSON 无法往返的参数（例如溢出为 `Infinity` 的 `1e400`）保留原始文本，而不是 `JSON.stringify` 会报告的 `null`。终止 `final` 事件刻意不做限长：它承载与默认模式相同的无损答案。
- 文本与推理在步骤提交时到达，而不是逐 token 到达；默认模式的 stderr 推理仍是唯一的实时文本通道。轮次内失败的运行仍以 `final` 结束且没有 `error` 事件，因此即使事件流格式良好，监督进程也要用退出码与 `turn_end` 原因来分类该次运行。
- `usage` 仅在该步每一次 attempt 都上报了样本时出现在 `step_end` 上，并累计这些样本——包括仅在被丢弃的 `assistant/attempt` 流中留下用量样本的重试——因此部分汇总不会被当作精确总量发布。
- 原始会话事件不在范围内。调试用的逃生口可以以后再加，不必改动这套词汇表。

### 会话身份

身份由运行时拥有。不带 `--session-id` 的运行生成 `session-<uuid>`，并在第一条事件里报告它。监督进程保存该值，并在下一次唤醒时传回。

`--session-id <id>` 是只采用：先观察持久化会话并 resume，日志不存在时失败。首轮不传该 flag，由运行时生成身份并在 `session` 事件里报告；后续每一轮都用该值指名并续接历史。请求的 id 没有持久化日志时报错，而不是开一段新会话，因此写错或过期的 id 不会静默开出一段调用方自以为在续接的空历史，JSONL 存储拒绝已存在日志 id 的问题（见 [session persistence](../../implemented/architecture/2026-06-14-session-persistence.zh.md)）也不会出现在这条路径上。标识是不透明的，因此 runner 只在 trim 后的值上校验非空，并把调用方的原始字符串（含空白字符）原样传下去。

采用时会比较持久化会话记录的 cwd 与进程 cwd，因为会话按项目目录组织（见 [project session directories](../../implemented/architecture/2026-07-24-project-session-directories.zh.md)）。不一致时以 `dsh:` 诊断退出 1，而不是静默续接一个根目录在别处的会话；未记录 cwd 的会话出于同样理由被拒绝。运行在 agent preset 下的会话被拒绝，因为本 bundle 不组合任何 preset roster：在这里 resume 它，会用 headless 的工具与提示词运行它，而不是它日志当前记录的组合。该检查读取日志当前记录的 preset——创建 header 再叠加任何 `agent-preset/selected` 事件——因为空白会话可能在创建后切换 preset，而 header 始终只是创建事实；畸形的选择记录会失败关闭，而不会读成「无 preset」。带父会话或子 agent 关联的会话——包括用户 fork 出的会话——被拒绝。本进程已存在持有请求 id 的存活 Agent 时直接拒绝：它的 owner 可能仍在驱动它，而 `whenIdle` 不是单条消息的完成信号，runner 无法对它取得独占区间。resume 后的日志会在 runner 等待 idle 后再次检查，因此该窗口内选中的 preset 仍会被拒绝。纯空白的 `sessionId` 在 CLI 与直接配置两条路径上都会被拒绝。两个存活进程不能写同一个 id；存储的写租约已经会拒绝第二个写入者。runner 通过已组合的 `sessionQuery` 服务读取观察结果，并在请求 `--session-id` 却没有该服务时显式失败——观察结果正是它找到待 resume id 的途径；若所请求的身份缺少让它持久化的 `sessionPersistence` 服务，同样显式失败。

## 后果

实际落地：`src/startup.ts` 解析 `--json` 与 `--session-id <id>`，把缺失或为 `-` 的任务视为"从 stdin 读取"，并且只在 stdin 是终端时抛出用法错误。`src/index.ts` 解析任务、采用指名的会话——未传 flag 时生成新身份——并接上 stderr 推理投影或新的 `src/json-stream.ts` 投影。`cordis.patch.yml` 转发这两个新设置。`package.json` 发布两个入口共同引用的共享 chunk `lib/json-stream-*.js`，因此安装后的 tarball 可以加载。

- 默认模式不变：纯文本运行向 stdout 写一行最终助手消息、stderr 无输出，退出码仍跟随终端原因。
- `--json` 的 stdout 逐行可解析为 JSON，以 `session` 开头、以 `final` 结尾，不含纯文本。该模式下 stderr 不承载推理。
- 发生重试的步骤只为最终提交的 attempt 发布 `text` 与 `thinking`，因此被丢弃的 attempt 不会在事件流中留下任何痕迹。
- 两次连续的相同 `--session-id` 运行共享历史，而请求一个没有持久化日志的 id 会在任务运行前退出 1。cwd 不一致、未记录 cwd、属于子 agent 或 fork 会话、运行在 agent preset 下、preset 记录畸形，或本进程已存在同 id 存活 Agent 的运行都以诊断退出 1。
- 无位置参数但 stdin 有管道输入时任务被采纳，只有空白的位置参数会被拒绝而不会消费管道，交互式无任务调用仍以用法错误失败。
- 单元覆盖落在 `packages/bundle/headless/tests/startup.spec.ts`、`tests/headless.spec.ts` 与 `tests/json-stream.spec.ts`。`apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts` 的产品 headless profile 期望测试端到端覆盖两种输出模式。

延期与未决：

- 每次运行的 `--model` 覆盖尚未实现。后续改动必须尊重 Session Controller 拥有的会话局部选择优先级，而不是覆盖已保存的选择。
- 冷启动加上日志重放会随会话变长而增长，因此长会话每次唤醒的代价高于新会话。
- `--json` 把推理从 stderr 移到 stdout，因此只监听 stderr 的日志收集器在该模式的有推理运行上什么都看不到。
- 有界的 `tool_result` 负载会让监督进程看不到完整输出；8 KiB 字符串/键上限与 32 KiB 行上限由 `src/json-stream.ts` 拥有，应保持为常量，终止 `final` 事件是唯一的例外。

## 备选方案

**`--verbose` 人类可读文本写到 stderr。** 监督进程解析的是 stdout，只落在 stderr 的投影对它不可见。默认模式的 stderr 推理已经是人类可读的 verbose 面。

**直接倾倒原始会话事件。** 它们在增量之外重复整条已组装消息，回显 `user/message`，还夹带内部事件。在同一条提示词上实测，pi 的增量流产生 84 行、11.7 KB，而 opencode 是 3 行、962 B；pi 大约四分之一的字节花在把同一条消息在 `message_end`、`turn_end`、`agent_end` 里重复三遍。

**用长驻 SDK 进程代替每次唤醒一个进程。** SDK 已经有结构化事件和显式的会话身份语义，但它会替换掉监督进程所依赖的"一次唤醒一个进程"模型。实测 headless profile 的冷启动约为热态 0.45 s、冷态 1.2 s，相对一个真实轮次很小。

**让监督进程生成会话 id。** 身份属于拥有日志的运行时。监督进程记录第一条事件报告的值即可。

**采用或创建语义的 `--session-id`。** 在日志不存在时创建所请求的 id，会让写错或过期的 id 静默开出一段监督进程自以为在续接的空历史；首轮本就不传该 flag 并从 `session` 事件读到生成的 id，因此没有任何调用方需要用 `--session-id` 来创建。

**任务只走 argv。** 长提示词会超出 `ARG_MAX`，并且把提示词暴露在进程列表里。
