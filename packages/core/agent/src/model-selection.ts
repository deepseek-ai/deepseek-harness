/** Agent-owned model selection, its durable projection, and scoped switch notices.
 * @module @deepseek-ai/dsh-agent/model-selection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Model, AgentOptions, PreStepDecision } from './runtime-types.ts'
import type { ModelSelection } from './types.ts'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { Session, EpochHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/**
 * Durable model-selection state for one Session. An effort the adapter
 * defaulted on a recorded request is omitted, so later requests resolve the
 * default again instead of pinning it as a choice.
 */
export interface ModelSelectionProjectionState {
  /** Selection used by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Later recorded selection not yet used by a matching model request. */
  readonly pending: ModelSelection | null
}

/**
 * Build a detached selection, omitting an absent effort.
 * @param provider - provider route.
 * @param model - provider-owned model id.
 * @param reasoningEffort - explicit effort; omission follows adapter defaults.
 * @returns a detached selection.
 */
function toSelection(provider: string, model: string, reasoningEffort: ReasoningEffortId | undefined): ModelSelection {
  return { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
}

/**
 * Compare provider and model without comparing reasoning effort.
 * @param left - first selection.
 * @param right - second selection.
 * @returns whether both selections name the same route.
 */
function sameRoute(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Compare complete selections, treating absent effort as its own value.
 * @param left - first selection, or no recorded selection.
 * @param right - second selection, or no recorded selection.
 * @returns whether both selections agree.
 */
function sameModelSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && sameRoute(left, right) && left.reasoningEffort === right.reasoningEffort)
}

/** Selection a recorded request used, omitting an effort the adapter defaulted. */
function selectionOfHeader({ config, adapterDefaults }: EpochHeader): ModelSelection {
  return toSelection(config.provider, config.model, adapterDefaults?.reasoningEffort === true ? undefined : config.reasoningEffort)
}

const selectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).transform(ReasoningEffortId).exactOptional(),
}).nullable()

/**
 * Session selection fold: recorded selections become
 * the pending choice, and each request header retires a matching one.
 */
export const modelSelectionProjectionDefinition: Required<ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>> = {
  key: 'modelSelection',
  stateVersion: 3,
  stateSchema: z.object({ lastUsed: selectionSchema, pending: selectionSchema }),
  init: () => ({ lastUsed: null, pending: null }),
  apply: (state, event) => {
    if (event.type === 'model/selection') {
      return sameModelSelection(state.pending, event.data) ? state : { ...state, pending: event.data }
    }
    if (event.type !== 'request/header') return state
    const lastUsed = selectionOfHeader(event.data.header)
    const pending = sameModelSelection(state.pending, lastUsed) ? null : state.pending
    return sameModelSelection(state.lastUsed, lastUsed) && pending === state.pending ? state : { lastUsed, pending }
  },
  wire: {
    viewSchema: z.object({ lastUsed: selectionSchema, next: selectionSchema }),
    view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),
  },
}

/**
 * Read and record one Agent's model choices without resolving adapter defaults.
 * @param readState - driver-owned reader for this Session's selection projection.
 * @param session - Session receiving durable model selections.
 * @param options - live route fallback until a selection or request is recorded.
 */
export class AgentModel implements Model {
  constructor(
    private readonly readState: () => ModelSelectionProjectionState,
    private readonly session: Session,
    private readonly options: AgentOptions,
  ) {}

  current(): Readonly<ModelSelection> | undefined {
    const recorded = this.recordedSelection()
    if (recorded !== null) return { ...recorded }
    const { provider, model, reasoningEffort } = this.options
    return provider && model ? toSelection(provider, model, reasoningEffort) : undefined
  }

  select(selection: Readonly<ModelSelection>): void {
    if (sameModelSelection(this.recordedSelection(), selection)) return
    this.session.append('model/selection', toSelection(selection.provider, selection.model, selection.reasoningEffort))
  }

  private recordedSelection(): ModelSelection | null {
    const state = this.readState()
    return state.pending ?? state.lastUsed
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'model-selection': { kind: 'model-selection' } & ContextFormed
  }
}

function routeLabel(route: ModelSelection, other: ModelSelection): string {
  return route.provider === other.provider ? route.model : `${route.provider}/${route.model}`
}

function modelSwitchNotice(previous: ModelSelection, selected: ModelSelection) {
  const from = routeLabel(previous, selected)
  const to = routeLabel(selected, previous)
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]`,
    }],
    source: {
      kind: 'model-selection',
      form: 'notice',
      summary: boundContextSummary(`${from} → ${to}`),
    },
  })
}

/**
 * Append a model-switch notice when the step's fixed route differs from the
 * last request header. Effort-only changes and empty no-request decisions add
 * no notice; a failure before header persistence repeats it on the next step.
 * Install in the selected Agent's unpublished setup scope.
 * @param agentCtx - The selected Agent's scoped context.
 * @returns Disposer for the scoped pre-step listener.
 */
export function installModelSelection(agentCtx: Context): () => void {
  return agentCtx.on(
    'agent/pre-step',
    async ({ agent, messages, signal, step, modelSelection }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      // The loop skips an empty first step and an emptied offered continuation.
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
      const previous = agent.session.requestHeader()?.config
      if (
        previous === undefined
        || (modelSelection.provider === previous.provider && modelSelection.model === previous.model)
      ) return decision
      return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, modelSelection)] }
    },
    { prepend: true },
  )
}
