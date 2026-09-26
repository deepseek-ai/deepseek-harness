# 用户交互

[English](user-questions.md) | 中文

[dsh-user-questions](../../packages/interaction/user-questions) 的用户交互 seam。它是工具或权限插件需要人类回答后 agent（智能体）才能继续时所使用的、提供方无关的词汇。Agent-scoped waterfall listener 组合可用的 UI 界面，其中包括转发到已连接 client 的 listener。

源码：[`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

## 问题选项

`AskUserQuestionOption` 包含一个可供选择的选项。`label` 是面向用户的选项文字，同时也是面向模型的选中值；`description` 是可选的 UI 帮助文本。

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## 呈现意图

`AskUserQuestionIntent` 可选地声明一种已知的决策类型。它按 `kind` 打标签，因此可以增加新的意图；不认识某个标签的 UI 渲染通用选项列表。意图只改变呈现方式——遵循它的 UI 回答的仍是通用 UI 会发送的那些选项标签，因此调用方两种情况下读到的回答字段相同。`approve` 指名肯定选项，而不依赖选项顺序。`ask()` 会拒绝两种无法由类型系统表达的情况：`approve` 未指向该问题自身的任何选项，以及为没有 `detail` 的问题指定意图。

```ts type-equiv
/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
type AskUserQuestionIntent = {
  /** A plan submitted for review: `detail` is the plan markdown `ask()` requires, and the decision approves or declines it. */
  kind: 'plan-review'
  /**
   * The option label that approves the plan; every other option declines it.
   * Named rather than positional so no UI infers the verdict from option order.
   * An `approve` naming no option of its own question is rejected at `ask()`.
   */
  approve: string
  /** Logged tool invocation whose arguments contain the reviewed plan. */
  callId?: ToolCallId
}
```

## 问题条目

`AskUserQuestionItem` 是请求中的一个问题。调用方提供稳定的 `id`，它会随答案原样返回，使批量问题仍可路由。可选的 `detail` 携带辅助文本；提供方会将其随问题渲染，但不会放入可选选项标签。

```ts type-equiv
/** One question in a user-questions request. */
interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
  /** Optional presentation intent for capable UIs; absent asks for the generic option list. */
  intent?: AskUserQuestionIntent
}
```

## 提问请求

`AskUserQuestionRequest` 是跨包请求。`questions` 是数组，这样 UI 可以在一个流程中呈现相关提示，同时保持每个回答有稳定的 id。如提供 `agent`，它必须与存活调用方是同一实例；只有当当前注册表将该实例识别为运行时根时，交互 seam 才会接纳该 agent。

```ts type-equiv
/** Request for a human answer. */
interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}
```

## 回答

提供方为每个问题 id 返回一个回答项。`selected` 包含选中的选项标签，`custom` 在用户输入自由文本时携带「其他」回答。对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 也可以使用 `selected` 为空且不含 `custom` 的回答项，在其余问题均已完成的批次中保留被跳过的问题。

```ts type-equiv
/** Answer to one question. */
interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}
```

```ts type-equiv
/** The human's answer. */
interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}
```

## 错误

`UserQuestionError` 继承 `HarnessError`，因此 `ctx.tools.execute()` 会保留 `{ name, code }`，用于面向模型的工具失败，如 `EMPTY_QUESTIONS`、`NO_PROVIDER`、`ASK_ABORTED` 或 UI 侧取消。

```ts type-equiv
/** Stable error taxonomy for user-questions failures. */
class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxuserquestions--userquestionservice"></a>

### `ctx.userQuestions` — `UserQuestionService`

`ctx.userQuestions`: validation plus the scoped answerer waterfall.

```ts cordis-catalog
/**
 * Ask the scoped answerer waterfall and wait for the user's answer.
 *
 * When a caller supplies an agent, human interaction is valid only for the
 * exact live runtime root. Runtime ownership, not durable session lineage,
 * decides this boundary: an owned child has no human answerer and would
 * block forever, while a lineage-bearing session resumed as a new runtime
 * root may ask normally.
 *
 * @param request Questions, owner agent, and abort signal.
 * @returns The answer chosen or typed by the human.
 * @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
 *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
 *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
 *   that live agent is owned by another agent.
 */
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
```

Source: [`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

<a id="user-questions-events"></a>

### `user-questions/*` events

<a id="user-questionsrequest--waterfall"></a>

#### `user-questions/request` — waterfall

Ask composed answerers for structured user input. Return an answer to claim the request or call `next()` to delegate. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Ask composed answerers for structured user input. Return an answer to
 * claim the request or call `next()` to delegate. Scope-filtered dispatch
 * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param request - pending user-question request.
 * @mode waterfall
 */
'user-questions/request'( this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>, ): Promise<AskUserQuestionAnswer>
```

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/interaction/user-questions/src/types.ts`](../../packages/interaction/user-questions/src/types.ts)
<!-- END GENERATED cordis-surface -->
