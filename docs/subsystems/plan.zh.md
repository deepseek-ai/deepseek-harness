# 计划模式

[English](plan.md) | 中文

计划模式是 [dsh-plan-mode](../../packages/plan/plan-mode) 拥有的、记录到日志的逐 agent（智能体）协作状态（`ctx.planMode`，`PlanModeController`）：激活期间，每个模型请求都会包含一段部署持有的指引。计划模式是**软性指引**。[沙箱模式](sandbox.zh.md)与[审批策略](approval.zh.md)分别强制限制；两者都不读写计划状态，因此部署需要分别配置它们。该包是可选项，agent loop（智能体循环）不依赖它。它贡献 `plan:policy` 提示词段落，并注册 `exit_plan_mode` 工具和 `/plan` 命令。[设计说明](../../packages/plan/plan-mode/README.zh.md)负责决策依据；[包 README](../../packages/plan/plan-mode/README.zh.md)负责模型体验与限制细节。

源码：[`packages/plan/plan-mode/src/index.ts`](../../packages/plan/plan-mode/src/index.ts)

## 已记录状态与恢复

`plan/mode`（`{ active: boolean }`）是仅记日志、整值替换的[会话事件](session.zh.md)：持久且可回放，绝不进入模型 transcript（文本记录）。`plan` 单元折叠已提交模式、命令结算结果和最近一次请求头记录的模式。`ctx.planMode` 要求注册表存在，并在激活期间等待 `plan` 和 `turnBoundary` 注册完成，之后通过保留的句柄读取状态。客户端只接收 `{ active, pending }`；恢复、fork 与压缩（compaction）都能从日志恢复两者。完整事件声明见[持久化日志事件目录](../persistence-catalog.zh.md)。

## 待生效选择与 pre-step 追加

由于每个会话事件都位于轮次之内，用户选择会保持待生效状态，直到下一个被接受的轮内 pre-step 在派生请求之前追加该选择，无论该 pre-step 位于哪个轮次。选择不会强制续行，因此在某轮最后一个被接受的 pre-step 之后作出的选择会在之后的轮次追加。`set(agent, active)` 记录待生效选择（目标值与已记录或已在等待的状态相同时不做任何事），`get(agent)` 返回 `{ active: boolean; pending?: boolean }`：用于组装当前步骤的已记录状态，以及等待追加的已选状态。

agent 运行时，唯一的追加点是前置（prepend）注册的 `agent/pre-step` 监听器。它会观察每个候选请求步骤，包括第 1 轮第 1 步和请求恢复重试；它先调用下游监听器，只在下游接受该步骤后追加。提示词准入发生在轮次开启之前，无法追加 `plan/mode`，因此在提示词处作出的选择由它开启的轮次内第一个被接受的 pre-step 追加。追加失败不能阻塞轮次，且该选择会继续等待之后被接受的轮内 pre-step。追加用户选择时还会记录一条插件来源的 `user/message` 通知，但仅当最后记录的请求头描述的是另一种状态时才记录，因此模型恰好在上下文变化时收到通知，且绝不重复。在某轮最后一个被接受的 pre-step 之后作出的选择只存在于进程内；如果进程在另一个被接受的轮内 pre-step 之前退出，该选择会丢失（[README 限制](../../packages/plan/plan-mode/README.zh.md#known-limitations-and-deferred-work)）。

## 配置

```ts type-equiv
/** Deployment-owned plan guidance. */
interface PlanModeConfig {
  /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
  section: string
}
```

`section` 缺失、为空白或不是字符串，以及任何未知键，都会在插件加载时失败，而不是被忽略。计划模式激活期间，确切的 `section` 文本以 order 50 渲染为 `plan:policy` [系统提示词段落](system-prompt.zh.md)；未激活的计划模式不贡献任何文本。

## 退出工具与 `/plan` 命令

[`exit_plan_mode`](../tool-catalog.zh.md#deepseek-aidsh-plan-mode) 采用渐进式披露：从已选计划状态首次为激活的步骤起准入，并在会话剩余部分保持准入，因此首次进入计划模式时它进入请求的工具声明，之后的切换只改变计划指引。原生与 PTC 执行使用同一准入集合；首次进入之前调用返回 `UNKNOWN_TOOL`，计划模式未提交时调用会失败。在计划模式中，它要求一份以 `#` 标题开头的完整 markdown 计划，并通过[用户交互 seam](user-questions.zh.md) 呈交评审。批准返回 `{ approved: true }`，并记录一个静默（不叙述）的待生效退出，由下一个被接受的轮内 pre-step 追加。因此，计划指引在 assistant 当前这批工具调用的剩余部分继续生效，而工具结果本身会报告这次转换。「继续规划」则是一次携带用户反馈的失败调用，模型据此修订并再次呈交。放弃评审返回 `{ approved: false }` 并结束当前轮次，计划模式保持激活，直到用户发出下一条消息。评审期间交互通道缺失或服务重载同样使调用失败，而不是静默离开计划模式。

当 [`ctx.commands`](commands.zh.md) 被组合时，插件注册 `/plan [off|message]`：单独的 `/plan` 选择计划模式；任何其他非空消息先选择计划模式，再通过 `agent.steer()` 提交该文本，使其在计划指引下成为下一步骤的普通已记录用户消息；确切参数 `off` 选择未激活，这还会在待生效条目被追加并对请求可见之前将其取消。

## 服务

`ctx.planMode` 拥有已记录的计划状态，在步骤开始时应用并叙述选中的状态，还拥有 `plan:policy` 段落、`/plan` 命令和按条件准入的退出工具；`get`/`set` 签名见生成的[服务目录](#ctxplanmode--planmodecontroller)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplanmode--planmodecontroller"></a>

### `ctx.planMode` — `PlanModeController`

`ctx.planMode`: owns logged plan state, applies and narrates selected state at step start, the `plan:policy` section, the `/plan` command, and the conditional exit tool. Client carriers expose the projection's cropped `{ active, pending }` view. Agent prompt assembly fails while the projection reader is not ready; callers must await plugin activation before running an agent.

```ts cordis-catalog
/**
 * Read the logged plan state and any selected state awaiting the next
 * accepted in-turn pre-step.
 *
 * @param agent The agent to read.
 * @returns Current logged state plus a pending selection, when present.
 */
get(agent: Agent): { active: boolean; pending?: boolean }

/**
 * Select whether plan mode should be active. Between turns the method
 * appends the change immediately because no in-turn pre-step will run until
 * another prompt starts a turn. The open-turn fold is the idle signal:
 * agent status stays `running` through post-turn checkpointing, when no
 * further in-turn pre-step runs. During an open turn the selection remains
 * pending until the next accepted in-turn pre-step. Repeated selection of
 * the current or already-pending state is a no-op.
 *
 * @param agent The agent to switch.
 * @param active Whether plan mode should be active.
 * @returns what happened: `committed` (logged now), `queued` (awaiting the
 * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
 * was cleared; the logged state already matches), or `noop` (already in that
 * state).
 */
set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
```

Types: [Agent](core.zh.md)

Source: [`packages/plan/plan-mode/src/index.ts`](../../packages/plan/plan-mode/src/index.ts)
<!-- END GENERATED cordis-surface -->
