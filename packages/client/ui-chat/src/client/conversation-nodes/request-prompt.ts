import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, RequestPromptInspector,
  SystemPromptState, SystemPromptInspector,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Complete system prompt rendered for one model request, or an in-history prompt update at its own position. */
    'system-prompt': { readonly text: string; readonly update?: true }
  }
}

interface RequestPromptState extends ReturnType<RequestPromptInspector> {
  readonly anchorSeq: number
  readonly showsPrompt: boolean
  readonly turn?: number
  readonly step?: number
}

/** Place a request's system prompt at the start of its visible message series. */
function requestPromptAnchor(
  match: ConversationMatch,
  previous: Readonly<RequestPromptState> | undefined,
  isInitial: boolean,
): number {
  if (match.location.kind !== 'step') return match.event.seq
  if (previous === undefined && !isInitial) return match.event.seq
  if (previous?.turn === match.location.turn.turn
    && previous.step === match.location.step.step) return match.event.seq
  return match.location.step.step === 1
    ? match.location.turn.start?.seq ?? match.location.step.start?.seq ?? match.event.seq
    : match.location.step.start?.seq ?? match.event.seq
}

/** Keep an already rendered prompt at its page-lifetime presentation anchor. */
function stableRequestPromptAnchor(
  context: ConversationNodeContext<RequestPromptState>,
  match: ConversationMatch,
  previous: Readonly<RequestPromptState> | undefined,
  isInitial: boolean,
): number {
  const current = context.current.get('chat') as ChatNode | null | undefined
  return current?.kind === 'system-prompt'
    ? current.anchorSeq
    : requestPromptAnchor(match, previous, isInitial)
}

/**
 * System-prompt surface node Definition for the Chat target. It owns every
 * `system/message` event on the Chat target so the unknown-surface fallback
 * never renders the prompt as a transcript row. Each nonempty append owns a
 * prompt card, even without a loaded request header. Initial cards precede
 * their step's input; in-history updates stay at their own positions. The
 * request-prompt Definition owns replacement and later-series cards. Positional
 * replacements advance the effective prompt without changing historical cards.
 * @param inspect - Pure surface interpretation supplied by uiConversation.
 * @returns The Chat system-prompt Definition.
 */
export function systemMessageDefinition(inspect: SystemPromptInspector): ConversationNodeDefinition<SystemPromptState> {
  return {
    kind: 'system-message',
    target: 'chat',
    match: event => event.type === 'system/message'
      || ('surfaceOp' in event && event.surfaceOp !== 'append')
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      return inspect(reader.previous<SystemPromptState>('system-message')?.state, match.event)
    },
    update: context => context.state,
    buildViewNode: (context) => {
      const state = context.state?.introduced
      if (state === undefined || state.text === ''
        || context.start?.event.type !== 'system/message' || context.start.event.surfaceOp !== 'append') return null
      const anchor = state.update ? state.seq : requestPromptAnchor(context.start, undefined, true)
      return chatNode(context, 'system-prompt', anchor, { text: state.text, ...state.update ? { update: true } : {} })
    },
  }
}

/**
 * Request-header prompt Definition for the Chat target. Resume and explicit
 * series starts retain a prompt card even when the system text is unchanged.
 * @param inspect - the shared prompt interpretation, supplied by the
 * uiConversation service (a client bundle cannot value-import it).
 * @returns the Chat request-prompt Definition.
 */
export function requestPromptDefinition(inspect: RequestPromptInspector): ConversationNodeDefinition<RequestPromptState> {
  return {
    kind: 'request-prompt',
    target: 'chat',
    match: event => event.type === 'request/header'
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (context, match, reader) => {
      if (match.event.type !== 'request/header') {
        throw new Error('request-prompt start requires request/header')
      }
      const previous = reader.previous<RequestPromptState>('request-prompt')?.state
      const systemContext = reader.previous<SystemPromptState>('system-message')
      const system = systemContext?.state.effective
      const location = match.location.kind === 'step'
        ? { turn: match.location.turn.turn, step: match.location.step.step }
        : {}
      const inspection = inspect(previous?.prompt, match.event, system)
      const change = inspection.change?.kind
      // Appended prompts own their cards; a same-step header must not repeat them.
      const systemEvent = systemContext?.matches[0]?.event
      const shownByUpdate = system !== undefined
        && systemEvent?.type === 'system/message' && systemEvent.surfaceOp === 'append'
        && (system.update || previous === undefined)
        && system.turn === location.turn
        && system.step === location.step
      return {
        anchorSeq: stableRequestPromptAnchor(
          context,
          match,
          previous,
          match.event.data.reason === 'initial',
        ),
        showsPrompt: !shownByUpdate && (previous === undefined
          || match.event.data.reason !== 'change'
          || match.event.data.startsSeries === true
          || change === 'system'
          || change === 'system-and-tools'),
        ...location,
        ...inspection,
      }
    },
    update: context => context.state,
    buildViewNode: (context) => {
      const state = context.state
      if (state === undefined) return null
      const current = context.current.get('chat') as ChatNode | null | undefined
      const visible = state.showsPrompt && state.prompt.system !== ''
      if (!visible && current?.kind !== 'system-prompt') return null
      return chatNode(
        context,
        'system-prompt',
        state.anchorSeq,
        { text: state.prompt.system },
        { visibility: visible ? 'visible' : 'hidden' },
      )
    },
  }
}

/**
 * Register the system-prompt surface node and the model-request prompt card in the Chat flow.
 * @param ctx - Owning UI Conversation context.
 */
export function registerRequestPromptConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(systemMessageDefinition(
    (previous, event) => ctx.uiConversation.inspectSystemPrompt(previous, event),
  ))
  ctx.uiConversation.events.register(requestPromptDefinition(
    (previous, event, system) => ctx.uiConversation.inspectRequestPrompt(previous, event, system),
  ))
}
