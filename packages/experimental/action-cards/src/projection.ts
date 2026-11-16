/** Recover cards from `action-card` blocks in answers and `propose_action` calls of older Sessions, and decisions from plugin records. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { actionCardFences } from './fence.ts'
import type { ActionCardId } from './types.ts'

/** Tool that offered cards before they moved into answer text; its successful calls in older Sessions are still cards. */
const PROPOSE_ACTION = 'propose_action'

/** Kind-defined JSON object of a proposal or decision. */
export const fieldsSchema = z.record(z.string(), z.json())

/** Fields of an `action-card` block or of an older `propose_action` call; blank titles and briefs create no card. */
const cardFieldsSchema = z.object({
  action: z.string().min(1),
  title: z.string().trim().min(1),
  brief: z.string().trim().min(1),
  details: fieldsSchema,
})

const cardIdSchema = z.string().min(1).transform(brandString<ActionCardId>)

const proposalSchema = z.object({
  cardId: cardIdSchema,
  turn: z.number().int().nonnegative(),
  action: z.string().min(1),
  title: z.string().min(1),
  brief: z.string().min(1),
  details: fieldsSchema,
}).strict()

/** Recorded decision of one card. */
export const decisionSchema = z.object({
  cardId: cardIdSchema,
  action: z.string().min(1),
  phase: z.string().min(1),
  data: fieldsSchema.optional(),
}).strict()

/** A decision record; records written before cards moved into answers name the card by its `propose_action` call id. */
const recordSchema = z.union([
  decisionSchema,
  decisionSchema.omit({ cardId: true }).extend({ callId: cardIdSchema }).strict()
    .transform(({ callId, ...decision }) => ({ cardId: callId, ...decision })),
])

const viewSchema = z.object({
  proposals: z.record(z.string(), proposalSchema),
  decisions: z.record(z.string(), decisionSchema),
})

const stateSchema = z.object({
  /** Fork-inherited prefix length; inherited events create no proposals or decisions. */
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  /** False in a subagent Session: its answers offer no card, because only a live root can act on one. */
  offers: z.boolean(),
  view: viewSchema,
  /** `propose_action` calls of the open turn still waiting for their result. */
  calls: z.record(z.string(), proposalSchema.omit({ cardId: true })),
  /** Turn of the latest admitted proposal; later blocks and calls of that turn create no card. */
  admittedTurn: z.number().int().nullable(),
  /** Decisions not yet reported to the model, by card id, with the seq of their record. */
  pendingStatus: z.record(z.string(), z.number()),
})

/** Fold state; `view` is also the Client wire value. */
export type ActionCardState = z.infer<typeof stateSchema>

type Proposal = z.infer<typeof proposalSchema>
type CardFields = z.infer<typeof cardFieldsSchema>

/** Type of {@link actionCardProjection}: the fold plus its Client view wire. */
export type ActionCardProjectionDefinition = Omit<ProjectionDefinition<'actionCards', ActionCardState>, 'wire'> & {
  readonly wire: NonNullable<ProjectionDefinition<'actionCards', ActionCardState>['wire']>
}

/** Admit a card for its turn. A newer card supersedes every unstarted card; the model made that choice, so no status is reported. */
function admitted(state: ActionCardState, proposal: Proposal): ActionCardState {
  const decisions = { ...state.view.decisions }
  for (const earlier of Object.values(state.view.proposals)) {
    if (decisions[earlier.cardId] === undefined) decisions[earlier.cardId] = { cardId: earlier.cardId, action: earlier.action, phase: 'replaced' }
  }
  return { ...state, admittedTurn: proposal.turn, view: { proposals: { ...state.view.proposals, [proposal.cardId]: proposal }, decisions } }
}

/** Parse model-written JSON; malformed text yields undefined, which no card schema accepts. */
function parsedJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return undefined } // Malformed model JSON creates no card.
}

/** Fields of the first valid `action-card` block in an answer's text blocks; reasoning is not read. */
function cardFieldsOf(message: AssistantMessage): CardFields | undefined {
  for (const block of message.content) {
    if (block.type !== 'text') continue
    for (const fence of actionCardFences(block.text)) {
      const fields = cardFieldsSchema.safeParse(parsedJson(fence))
      if (fields.success) return fields.data
    }
  }
  return undefined
}

/**
 * Full-Session fold. The first valid `action-card` block in a turn's answer text becomes the card, named by the id of
 * its assistant message; in an older Session a successful `propose_action` result does the same, named by the call id.
 * Later blocks and calls of that turn create no card, and a newer card replaces every unstarted earlier card.
 * Interrupted answers, subagent Sessions and events inherited by a forked Session create no proposals.
 */
export const actionCardProjection: ActionCardProjectionDefinition = {
  key: 'actionCards', stateVersion: 3, stateSchema,
  init: (header, inheritedEventCount) => ({
    inheritedEventCount, offers: header.origin !== 'subagent', view: { proposals: {}, decisions: {} }, calls: {}, admittedTurn: null,
    pendingStatus: {},
  }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'turn/start':
        // A turn's calls settle inside it; a call left without a result never becomes a card.
        return Object.keys(state.calls).length === 0 ? state : { ...state, calls: {} }
      case 'user/message': {
        if (event.data.source.kind !== 'action-cards') return state
        const through = event.data.source.through
        return { ...state, pendingStatus: Object.fromEntries(Object.entries(state.pendingStatus).filter(([, seq]) => seq > through)) }
      }
      case 'assistant/message': {
        const { turn, message, interrupted } = event.data
        if (!state.offers || interrupted === true || state.admittedTurn === turn) return state
        const fields = cardFieldsOf(message)
        return fields === undefined ? state : admitted(state, { cardId: brandString<ActionCardId>(message.id), turn, ...fields })
      }
      case 'tool/call': {
        if (event.data.name !== PROPOSE_ACTION) return state
        const parsed = cardFieldsSchema.safeParse(parsedJson(event.data.arguments))
        if (!parsed.success) return state
        return { ...state, calls: { ...state.calls, [event.data.callId]: { turn: event.data.turn, ...parsed.data } } }
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const call = Object.hasOwn(state.calls, callId) ? state.calls[callId] : undefined
        if (call === undefined) return state
        const calls = Object.fromEntries(Object.entries(state.calls).filter(([id]) => id !== callId))
        if (event.data.message.isError === true || state.admittedTurn === call.turn) return { ...state, calls }
        return admitted({ ...state, calls }, { cardId: brandString<ActionCardId>(callId), ...call })
      }
      default: {
        const record = pluginRecordOf(event)
        if (record?.type !== 'plugin:action-cards/decision') return state
        // A malformed or newer record is skipped; throwing here would fail every later read of this Session.
        const decision = recordSchema.safeParse(record.data)
        if (!decision.success) return state
        return { ...state, view: { ...state.view, decisions: { ...state.view.decisions, [decision.data.cardId]: decision.data } },
          pendingStatus: { ...state.pendingStatus, [decision.data.cardId]: event.seq } }
      }
    }
  },
  wire: { summary: false, viewSchema, view: (state: ActionCardState) => state.view },
}
