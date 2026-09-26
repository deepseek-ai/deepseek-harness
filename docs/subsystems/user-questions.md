# User Interaction

English | [中文](user-questions.zh.md)

The user-questions seam of [dsh-user-questions](../../packages/interaction/user-questions). It is the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue. Agent-scoped waterfall listeners compose the available UI surfaces, including listeners relayed to a connected client.

Source: [`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

## Question options

`AskUserQuestionOption` contains one selectable choice. `label` is the user-facing option text and also the model-facing selected value; `description` is optional UI help text.

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## Presentation intent

`AskUserQuestionIntent` optionally declares a known decision kind. It is tagged on `kind` so intents can be added; a UI that does not recognise a tag renders the generic option list. An intent changes presentation only — a UI honouring it answers with the same option labels a generic UI would send, so the caller reads the same answer fields either way. `approve` names the affirmative option instead of relying on option order. `ask()` rejects the two assertions no type can carry: an `approve` naming none of its own question's options, and an intent on a question with no `detail`.

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

## Question item

`AskUserQuestionItem` is one question in a request. The caller supplies a stable `id`, which is echoed back with the answer so batched questions remain routable. Optional `detail` carries supporting text that providers render with the question but keep out of selectable option labels.

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

## Ask request

`AskUserQuestionRequest` is the cross-package request. `questions` is an array so a UI can present related prompts in one flow while preserving a stable id per answer. When present, `agent` is the exact live caller; the interaction seam admits it only while the live registry identifies that instance as a runtime root.

```ts type-equiv
/** Request for a human answer. */
interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}
```

## Answer

Providers return one answer item per question id. `selected` contains selected option labels, and `custom` carries a free-form "Other" answer when the user typed one. For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may also use an item with empty `selected` and no `custom` to preserve a skipped question in an otherwise completed batch.

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

## Errors

`UserQuestionError` extends `HarnessError`, so `ctx.tools.execute()` preserves `{ name, code }` for model-facing tool failures such as `EMPTY_QUESTIONS`, `NO_PROVIDER`, `ASK_ABORTED`, or UI-side cancellation.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/interaction/user-questions/src/types.ts`](../../packages/interaction/user-questions/src/types.ts)
<!-- END GENERATED cordis-surface -->
