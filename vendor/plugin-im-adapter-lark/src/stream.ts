/**
 * The CardKit `patch` stream driver of the Lark / Feishu adapter.
 *
 * A **card entity** is the only Lark message that can be updated per element, so a streamed card is: create the entity
 * (`POST cardkit/v1/cards`) with `streaming_mode: true`, send it **once** as an `interactive` message whose content is
 * the reference `{ type: 'card', data: { card_id } }`, then replace parts of it as the state grows, and finally switch
 * streaming off. The scheduler owns coalescing, throttling, retries and the single-message rule; this module owns the
 * platform bookkeeping:
 *
 * | call | what it does | requests |
 * |---|---|---|
 * | `open` | create the entity (streaming on), send the reference through `send.ts` (reply/thread rules unchanged) | `POST cards`, `POST messages` |
 * | `tick` with `patches` | one request per {@link CardKitOp}: `PUT …/elements/:id/content` (typewriter), `PATCH …/elements/:id`, `POST …/elements`, `DELETE …/elements/:id` | 1..N |
 * | `tick` without `patches` | the whole document: `PUT cardkit/v1/cards/:id` (a `replace` diff, or a retry that left the platform state unknown) | 1 |
 * | `close` | the whole final document with `streaming_mode: false` (publishes the last state **and** ends streaming) | 1 |
 *
 * Everything platform-specific about streamed cards lives here:
 *
 * - **`sequence`**: every CardKit write carries a strictly increasing number per entity. The counter lives in
 *   `handle.state` and every request takes a fresh number through {@link nextSequence} *before* it is sent, so a number
 *   is never reused — not even by a retried request. A partially applied tick keeps its remaining operations in the
 *   state, so a retry resumes the queue instead of repeating requests that already reached the platform; if the
 *   platform does diverge anyway, the next `replace`/`close` publishes the whole document and reconciles it.
 * - **Budget**: 10 QPS per card (`limit.stream.interval = 120` is already in the mode, so the scheduler never ticks
 *   faster) and the streaming window: the platform forces `streaming_mode` off 10 minutes after it was enabled, so
 *   {@link StreamDriver.budget} reports `until = openedAt + 10 min − margin` and the scheduler stops intermediate ticks
 *   at the horizon. A state that arrives after the window is published as a full update instead of a typewriter tick —
 *   the content still lands, only the animation is gone.
 * - **Size / shape**: the card mode's `check()` already reports element count and payload bytes; a payload that is not
 *   a card document at all (the mode split an `audio`/`video`/`file` out of the message) cannot be shown by a card
 *   entity, so the driver throws {@link StreamLimitError} `shape` and the scheduler recalls the streamed card and sends
 *   the final state as an ordinary message.
 * - **Streaming off** is a hard requirement, not a nicety: the platform rejects a card callback while the card still
 *   streams, and a card left in streaming mode keeps showing a "generating" state forever.
 *
 * One driver instance serves every stream of a bot: the per-message bookkeeping lives in the handle state, which is
 * what keeps {@link ./bot.ts LarkBot.streamDriver} cheap and pure (core calls it once per mode lookup).
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-lark/stream
 */

import {
  nextSequence,
  PlatformError,
  StreamLimitError,
  type MessageHandle,
  type Prepared,
  type SendContext,
  type StreamDriver,
  type StreamTickContext,
} from '@deepseek-ai/cordis-plugin-im-core'
import type { LarkBot } from './bot.ts'
import {
  cardKitOps,
  streamingCard,
  type CardDraft,
  type CardJson,
  type CardKitOp,
  type CardPayload,
  type CardPatch,
  type CardTypes,
} from './modes/card.ts'
import { sendMessagePayload, type LarkPayload } from './send.ts'

/** How long the platform keeps a card entity streaming before it forces `streaming_mode` off. */
export const CARD_STREAM_WINDOW_MS = 10 * 60_000
/** Distance kept from the end of the streaming window, so the last request is not cut off by the platform. */
export const CARD_STREAM_WINDOW_MARGIN_MS = 30_000

/**
 * The adapter-private `handle.state` of a streamed card: everything the driver needs from one request to the next.
 *
 * `cardId` and `sequence` are also what `send.ts` (`editMessagePayload`) reads when something edits a published
 * `card-entity` outside a stream.
 */
export interface LarkCardStreamState {
  /** Entity id of the card the stream publishes into. */
  cardId: string
  /** Last `sequence` handed to the platform; {@link nextSequence} bumps it before every request. */
  sequence: number
  /** When the stream opened (epoch ms): the streaming window is measured from here. */
  openedAt: number
  /** Operations of a tick that is being retried; absent between ticks. */
  pending?: CardKitOp[] | undefined
}

/** Options of {@link createCardStreamDriver}. */
export interface CardStreamDriverOptions {
  /** Clock of the streaming window and of `SentPart.time`; injected by tests. */
  now?: () => number
}

/**
 * The card document of one serialized payload.
 *
 * @param payload - the mode's payload for this state (`{ msg_type, content }`).
 * @returns the card JSON 2.0 document the entity is created/updated with.
 * @throws StreamLimitError `shape` when the state is not a card at all (a media message split out of the tree), so
 * the scheduler sends it as an ordinary message instead of leaving a card showing something else.
 */
function cardOf(payload: unknown): CardJson {
  const value = payload as Partial<CardPayload> | null | undefined
  if (!value || typeof value !== 'object' || value.msg_type !== 'interactive' || !value.content) {
    const kind = (value as { msg_type?: unknown } | undefined)?.msg_type
    throw new StreamLimitError({
      kind: 'shape',
      message: `lark: a card stream publishes card documents in one message, not a ${String(kind ?? 'unknown')} message`,
    })
  }
  return value.content as CardJson
}

/**
 * Refuse a whole document the platform will not take (`size`).
 *
 * The mode's own `check()` measures every state with placeholder image keys before the scheduler publishes it; this
 * guard covers the states the driver sends as a whole document (an `open`, a `replace`, the final `close`), where a
 * real resource key can push the JSON past the limit the placeholders did not reach.
 *
 * @param bot - the adapter (the card mode carries the configured `limit.payload.bytes`).
 * @param card - the document about to be sent.
 * @throws StreamLimitError `size`, which the scheduler resolves by recalling the streamed card and sending the final
 * state as an ordinary message — or, when even that does not fit, by failing the stream with the violation.
 */
function assertFits(bot: LarkBot, card: CardJson): void {
  const limit = bot.modes.card.limits?.['limit.payload.bytes']
  if (limit === undefined) return
  const bytes = new TextEncoder().encode(JSON.stringify(card)).length
  if (bytes <= limit) return
  throw new StreamLimitError({
    kind: 'size',
    key: 'limit.payload.bytes',
    limit,
    actual: bytes,
    message: `lark: the card JSON is ${bytes} bytes and the platform accepts ${limit}`,
  })
}

/**
 * The stream bookkeeping of a handle this driver created.
 *
 * @param handle - the streamed message.
 * @returns its {@link LarkCardStreamState}.
 * @throws PlatformError `fatal` when the handle was not created by this driver (a programming error, not a platform one).
 */
function stateOf(handle: MessageHandle): LarkCardStreamState {
  const state = handle.state as LarkCardStreamState | undefined
  if (!state || typeof state !== 'object' || typeof state.cardId !== 'string' || typeof state.sequence !== 'number') {
    throw new PlatformError('fatal', 'lark: the stream handle does not carry the CardKit state')
  }
  return state
}

/** Whether the platform has already forced streaming off for this entity (10-minute window). */
function windowClosed(state: LarkCardStreamState, now: number): boolean {
  return now >= state.openedAt + CARD_STREAM_WINDOW_MS
}

/**
 * Whether a diff changes the element set rather than only the content of elements already on the card.
 *
 * Element ids are positional, so an inserted element and the deleted element it replaces address different ids in the
 * same tick. Applied one request at a time the platform can accept the first and reject a later one, which leaves the
 * card showing neither the old nor the new control. One whole-document update is a single request and cannot land
 * partially.
 *
 * @param patches - the scheduler's diff of the current state against the published one.
 * @returns `true` when the tick inserts or deletes an element.
 */
function changesStructure(patches: readonly CardPatch[]): boolean {
  return patches.some(patch => patch.op === 'insert' || patch.op === 'delete')
}

/**
 * Apply one diff op as one CardKit request (`tick`), each with its own fresh `sequence`.
 *
 * @param bot - the adapter (its `cards` client).
 * @param state - bookkeeping of the streamed card; its `sequence` advances for every request.
 * @param op - one operation of `cardKitOps()`.
 * @param signal - cancellation of this request.
 */
async function applyOp(bot: LarkBot, state: LarkCardStreamState, op: CardKitOp, signal?: AbortSignal): Promise<void> {
  switch (op.type) {
    case 'content':
      // `PUT …/elements/:id/content` replaces the text of one markdown component; `append` only decides whether the
      // platform animates it, which is why both a prefix extension and a rewrite use this route.
      await bot.cards.content(state.cardId, op.elementId, op.content, nextSequence(state), signal)
      return
    case 'patch':
      await bot.cards.patchElement(state.cardId, op.elementId, op.partial, nextSequence(state), signal)
      return
    case 'insert': {
      const position = {
        ...op.before === undefined ? {} : { before: op.before },
        ...op.after === undefined ? {} : { after: op.after },
      }
      await bot.cards.insertElements(state.cardId, op.elements, position, nextSequence(state), signal)
      return
    }
    case 'delete':
      await bot.cards.deleteElement(state.cardId, op.elementId, nextSequence(state), signal)
  }
}

/**
 * Apply the operations of one tick, resuming a queue a failed attempt left behind.
 *
 * A retried tick carries the same operations; repeating the ones the platform already accepted would delete/insert
 * twice, so the queue is stored on the handle state and drained as requests succeed.
 *
 * @param bot - the adapter.
 * @param state - bookkeeping of the streamed card.
 * @param ops - operations of this tick.
 * @param signal - cancellation.
 */
async function drain(bot: LarkBot, state: LarkCardStreamState, ops: readonly CardKitOp[], signal?: AbortSignal): Promise<void> {
  if (!state.pending) state.pending = [...ops]
  const queue = state.pending
  while (queue.length) {
    await applyOp(bot, state, queue[0]!, signal)
    queue.shift()
  }
  state.pending = undefined
}

/**
 * Publish the whole document (full update), the route for a `replace` diff and for the final state.
 *
 * @param bot - the adapter.
 * @param state - bookkeeping of the streamed card.
 * @param card - the complete card JSON 2.0 document.
 * @param streaming - keep CardKit streaming on (a mid-stream replacement) or switch it off (the final state).
 * @param signal - cancellation.
 */
async function fullUpdate(bot: LarkBot, state: LarkCardStreamState, card: CardJson, streaming: boolean, signal?: AbortSignal): Promise<void> {
  await bot.cards.update(state.cardId, streamingCard(card, streaming), nextSequence(state), signal)
}

/**
 * The CardKit `patch` driver.
 *
 * @param bot - the adapter (its CardKit client, `sendPayload` and identity).
 * @param options - clock override for tests.
 * @returns the driver: `open` creates the entity and sends it, `tick` applies patches or the whole document, `close`
 * publishes the final document with `streaming_mode: false`, `budget` reports the end of the streaming window.
 */
export function createCardStreamDriver(bot: LarkBot, options: CardStreamDriverOptions = {}): StreamDriver<CardTypes> {
  const now = options.now ?? Date.now
  return {
    strategy: 'patch',

    /**
     * Open the stream: create the card entity with streaming enabled and send the reference to it as one `interactive`
     * message. The send goes through `send.ts`, so the reply/thread rules and the per-part `uuid` are the same as for
     * any other message.
     *
     * A retried `open` creates a second entity (the platform cannot dedupe a card creation), whose entity id expires
     * after 14 days unused; the published message is the one the later ticks address.
     *
     * @param _first - prepared draft of the first state (the payload is what the entity is created from).
     * @param payload - serialized card payload of the first state.
     * @param ctx - tick context of the first publication.
     * @returns the handle of the streamed message, carrying {@link LarkCardStreamState}.
     */
    async open(_first, payload, ctx: StreamTickContext): Promise<MessageHandle> {
      const card = streamingCard(cardOf(payload), true)
      assertFits(bot, card)
      const cardId = await bot.cards.create(card, ctx.signal)
      const reference: LarkPayload = { msg_type: 'interactive', content: { type: 'card', data: { card_id: cardId } } }
      const send: SendContext = {
        index: 0,
        options: ctx.options,
        previous: [],
        ...ctx.quote === undefined ? {} : { quote: ctx.quote },
      }
      const part = await sendMessagePayload(bot, reference, ctx.target, send)
      const openedAt = now()
      const state: LarkCardStreamState = { cardId, sequence: 0, openedAt }
      return {
        bot: bot.id,
        target: ctx.target,
        mode: ctx.mode,
        parts: [part],
        createdAt: openedAt,
        edits: 0,
        content: ctx.content,
        state,
      }
    },

    /**
     * Publish one coalesced state (`patch`): the diff's operations one request each, or the whole document when
     * the scheduler had no incremental change (`replace`, or the platform state became unknown after an error) and
     * once the 10-minute streaming window has closed.
     *
     * @param handle - the streamed message.
     * @param change - new prepared draft, serialized card payload, and the scheduler's diff when it had one.
     * @param ctx - tick context.
     * @throws StreamLimitError `shape` for a state a card message cannot show (a media message).
     */
    async tick(
      handle: MessageHandle,
      change: { draft: Prepared<CardDraft>; payload: CardPayload; patches?: CardPatch[] },
      ctx: StreamTickContext,
    ): Promise<void> {
      const state = stateOf(handle)
      const card = cardOf(change.payload)
      const closed = windowClosed(state, now())
      if (!change.patches || closed || changesStructure(change.patches)) {
        // A full update is the only honest publication here: streaming is either unknown (a retried tick), already
        // over, or the element set itself changed. Element ids are positional, so an insert plus the delete it
        // replaces are separate requests that the platform can reject halfway, leaving the card with the old control
        // removed and its replacement missing.
        state.pending = undefined
        assertFits(bot, card)
        await fullUpdate(bot, state, card, !closed, ctx.signal)
      } else {
        await drain(bot, state, cardKitOps(change.patches, change.draft), ctx.signal)
      }
      handle.edits += 1
    },

    /**
     * Publish the final state and end platform streaming: one full update with `streaming_mode: false`, which
     * is also what the platform needs before it accepts a callback on the card. It is sent even when the content did
     * not change, because switching streaming off is the point of this call.
     *
     * @param handle - the streamed message.
     * @param last - prepared draft and payload of the final state.
     * @param ctx - tick context.
     * @throws StreamLimitError `shape` when the final state is not a card document (a media message); the scheduler
     * then recalls the streamed card and sends the state as an ordinary message.
     */
    async close(
      handle: MessageHandle,
      last: { draft: Prepared<CardDraft>; payload: CardPayload },
      ctx: StreamTickContext,
    ): Promise<void> {
      const state = stateOf(handle)
      state.pending = undefined
      const card = cardOf(last.payload)
      assertFits(bot, card)
      await fullUpdate(bot, state, card, false, ctx.signal)
    },

    /**
     * The end of the streaming window, which is this driver's only budget: CardKit has no per-message edit
     * count and the 10 QPS limit is already a mode interval (`limit.stream.interval = 120`) the scheduler clamps to.
     *
     * @param handle - the streamed message.
     * @returns `until` = `openedAt + 10 min − margin`; `updatesLeft` is not reported (it is unbounded).
     */
    budget(handle: MessageHandle): { updatesLeft?: number; until?: number } {
      const state = stateOf(handle)
      return { until: state.openedAt + CARD_STREAM_WINDOW_MS - CARD_STREAM_WINDOW_MARGIN_MS }
    },
  }
}
