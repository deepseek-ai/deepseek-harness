/**
 * The `turnOutline` projection unit: a pure fold of `turn/start` boundaries,
 * first human prompts, and final assistant responses into the whole-log turn
 * outline the chat rail renders for turns outside a client's paged event
 * window.
 *
 * `turn/start` — not the prompt `user/message` — anchors each entry because
 * its seq is the load-through target for a jump: the loop logs `turn/start`
 * before the turn's prompt and steps, so a window paged back through that seq
 * contains the whole turn. Previews mirror the rail's loaded-turn previews
 * (space-joined text blocks, collapsed whitespace, an ellipsis when clipped)
 * with budgets sized to the rail card's clamps — one prompt line, up to three
 * response lines — so a turn shows the same words before and after its events
 * load. The response commits at `turn/end` from a draft of the newest
 * text-bearing assistant message; draft-only applies keep the `turns` array's
 * identity, so the identity-gated change feed pushes at most three times per
 * turn (boundary, prompt, response).
 *
 * @module @deepseek-ai/dsh-session-turn-outline/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TurnOutlineEntry, TurnOutlineState } from './types.ts'

/** Prompt budget: one rail-card line (13px over ~276px), ASCII worst case included. */
const PROMPT_PREVIEW_LIMIT = 50
/** Response budget: three rail-card lines (12px over ~276px). */
const RESPONSE_PREVIEW_LIMIT = 120

type MessageContent = SessionEvent<'user/message'>['data']['content']

/** Space-join text blocks, collapse whitespace, and cap at `limit` with a trailing ellipsis when clipped. */
function preview(content: MessageContent, limit: number): string {
  let text = ''
  let unread = false
  for (const block of content) {
    if (block.type !== 'text') continue
    if (text.length >= limit * 2) {
      unread = true
      break
    }
    // Per-block bound: the fold runs on every message event, so a single
    // multi-megabyte block must not be concatenated (and regex-normalized)
    // whole for a preview this short.
    const clipped = block.text.length > limit * 2
    const chunk = clipped ? block.text.slice(0, limit * 2) : block.text
    text += text === '' ? chunk : ` ${chunk}`
    if (clipped) {
      unread = true
      break
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}…`
  return unread ? `${normalized}…` : normalized
}

const turnOutlineEntriesSchema: ZodType<readonly TurnOutlineEntry[]> = z.array(z.object({
  turn: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  prompt: z.string().max(PROMPT_PREVIEW_LIMIT),
  response: z.string().max(RESPONSE_PREVIEW_LIMIT),
}).strict()).superRefine((turns, context) => {
  let previous = -1
  for (const entry of turns) {
    if (entry.turn <= previous) {
      context.addIssue({ code: 'custom', message: 'turn outline entries must be strictly increasing by turn' })
      return
    }
    previous = entry.turn
  }
})

const turnOutlineStateSchema: ZodType<TurnOutlineState> = z.object({
  turns: turnOutlineEntriesSchema,
  draft: z.string().max(RESPONSE_PREVIEW_LIMIT),
}).strict()

const EMPTY_OUTLINE: TurnOutlineState = { turns: [], draft: '' }

/** The `turnOutline` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const turnOutlineProjectionDefinition = {
  key: 'turnOutline',
  stateVersion: 2,
  stateSchema: turnOutlineStateSchema,
  init: () => EMPTY_OUTLINE,
  apply: (state, event) => {
    // Every uninteresting event returns the same reference (Object.is gates
    // the drive), and draft-only changes keep `turns` identity (the raw-view
    // identity gate then keeps the change feed quiet).
    switch (event.type) {
      case 'turn/start': {
        const last = state.turns.at(-1)
        // Order guard: a boundary that does not advance the turn number keeps
        // the outline sorted, and a retried turn's previews land on the
        // standing entry.
        if (last !== undefined && event.data.turn <= last.turn) return state
        return {
          turns: [...state.turns, { turn: event.data.turn, seq: event.seq, prompt: '', response: '' }],
          draft: '',
        }
      }
      case 'user/message': {
        // Only the newest turn can still be waiting for its opening human
        // prompt; later human messages in the same turn (steering) keep the
        // first preview.
        if (event.data.source.kind !== 'user') return state
        const last = state.turns.at(-1)
        if (last === undefined || last.prompt !== '') return state
        const prompt = preview(event.data.content, PROMPT_PREVIEW_LIMIT)
        if (prompt === '') return state
        return { turns: [...state.turns.slice(0, -1), { ...last, prompt }], draft: state.draft }
      }
      case 'assistant/message': {
        // Newest text-bearing message wins; the buffer commits at turn/end.
        const draft = preview(event.data.message.content, RESPONSE_PREVIEW_LIMIT)
        if (draft === '' || draft === state.draft) return state
        return { turns: state.turns, draft }
      }
      case 'turn/end': {
        if (state.draft === '') return state
        const last = state.turns.at(-1)
        if (last === undefined || last.response === state.draft) return { turns: state.turns, draft: '' }
        return { turns: [...state.turns.slice(0, -1), { ...last, response: state.draft }], draft: '' }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: turnOutlineEntriesSchema,
    view: state => state.turns,
  },
} satisfies ProjectionDefinition<'turnOutline', TurnOutlineState>
