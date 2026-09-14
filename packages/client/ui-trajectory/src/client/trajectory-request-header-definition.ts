import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, RequestPromptInspector, SystemPromptState, SystemPromptInspector,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { trajectoryNode } from './trajectory-definition-common.ts'
import type { TrajectoryRequestHeaderState } from './trajectory-contract.ts'

/** Loaded system surface plus the latest request facts changed by an append or compaction. */
export interface TrajectorySystemMessageState extends SystemPromptState {
  /**
   * Latest synthetic header, retained across unrelated replacements. Only the
   * Context whose start seq equals this header's seq contributes a view Node.
   */
  readonly header?: TrajectoryRequestHeaderState
}

/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
/**
 * Definition retaining each `system/message` surface node for the Trajectory
 * request-header Definition, which reads it through `reader.previous` and
 * presents the prompt through the request's `system` cell. A node that
 * lacks a loaded header contributes known text without request config or tools; an in-history
 * update contributes a request-header fact at its own position, since no
 * `request/header` follows a prompt change that keeps the cached history.
 * Surface replacements also contribute prompt changes when they remove the
 * effective node; earlier request facts remain historical.
 * @param inspect - Pure surface interpretation supplied by uiConversation.
 * @returns The Trajectory system-prompt Definition.
 */
function trajectorySystemMessageDefinition(inspect: SystemPromptInspector): ConversationNodeDefinition<TrajectorySystemMessageState> {
  return {
    kind: 'trajectory-system-message',
    target: 'trajectory',
    match: event => event.type === 'system/message'
      || ('surfaceOp' in event && event.surfaceOp !== 'append')
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      const prior = reader.previous<TrajectorySystemMessageState>('trajectory-system-message')?.state
      const state = inspect(prior, match.event)
      const node = state.effective
      if (state.uncertain) {
        const header = reader.previous<TrajectoryRequestHeaderState>('trajectory-request-header')?.state
        if (header === undefined) return state
        return {
          ...state,
          header: {
            seq: match.event.seq, time: match.event.time, location: match.location,
            prompt: { ...header.prompt, system: '' },
          },
        }
      }
      if (node === undefined || node.text === prior?.effective?.text
        || (state.introduced !== undefined && !state.introduced.update)) {
        return { ...state, ...(prior?.header === undefined ? {} : { header: prior.header }) }
      }
      const header = reader.previous<TrajectoryRequestHeaderState>('trajectory-request-header')?.state
      const systemHeader = prior?.header
      const previous = systemHeader !== undefined && (header === undefined || systemHeader.seq > header.seq)
        ? systemHeader
        : header
      if (previous === undefined) return state
      return {
        ...state,
        header: {
          seq: node.seq,
          time: node.time,
          prompt: { ...previous.prompt, system: node.text },
          change: { seq: node.seq, time: node.time, kind: 'system', previous: previous.prompt },
          location: match.location,
        },
      }
    },
    update: context => context.state,
    buildViewNode: (context) => {
      const state = context.state
      if (state?.header !== undefined && state.header.seq === context.start?.event.seq) {
        return trajectoryNode(context, state.header.seq, { kind: 'request-header', header: state.header })
      }
      const prompt = state?.introduced
      return prompt !== undefined && prompt.text !== ''
        && context.start?.event.type === 'system/message' && context.start.event.surfaceOp === 'append'
        ? trajectoryNode(context, prompt.seq, { kind: 'system-prompt', prompt })
        : null
    },
  }
}
/* jscpd:ignore-end */

/**
 * Request-header fact Definition for the Trajectory target.
 * @param inspect - the shared prompt interpretation, supplied by the
 * uiConversation service (a client bundle cannot value-import it).
 * @returns the Trajectory request-header Definition.
 */
function trajectoryRequestHeaderDefinition(inspect: RequestPromptInspector): ConversationNodeDefinition<TrajectoryRequestHeaderState> {
  return {
    kind: 'trajectory-request-header',
    target: 'trajectory',
    match: event => event.type === 'request/header'
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      if (match.event.type !== 'request/header') {
        throw new Error('trajectory-request-header start requires request/header')
      }
      const header = reader.previous<TrajectoryRequestHeaderState>('trajectory-request-header')?.state
      const state = reader.previous<TrajectorySystemMessageState>('trajectory-system-message')?.state
      const systemHeader = state?.header
      const previous = systemHeader !== undefined && (header === undefined || systemHeader.seq > header.seq)
        ? systemHeader.prompt
        : header?.prompt
      const system = state?.effective
      const inspection = inspect(previous, match.event, system)
      const { prompt } = inspection
      const change = inspection.change ?? (systemHeader !== undefined
        && (header === undefined || systemHeader.seq > header.seq) ? systemHeader.change : undefined)
      return {
        seq: match.event.seq,
        time: match.event.time,
        prompt,
        location: match.location,
        ...(change === undefined ? {} : { change }),
      }
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
      ? null
      : trajectoryNode(context, context.state.seq, {
        kind: 'request-header',
        header: context.state,
      }),
  }
}

/**
 * Register Trajectory system-prompt node and request-header facts.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryRequestHeaderDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(trajectorySystemMessageDefinition(
    (previous, event) => ctx.uiConversation.inspectSystemPrompt(previous, event),
  ))
  ctx.uiConversation.events.register(trajectoryRequestHeaderDefinition(
    (previous, event, system) => ctx.uiConversation.inspectRequestPrompt(previous, event, system),
  ))
}
