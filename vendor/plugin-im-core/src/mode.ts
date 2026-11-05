/**
 * Adapter mode contract: a mode owns an element registry and turns platform nodes into drafts (`assemble`) and drafts
 * into exact request bodies (`serialize`).
 *
 * What a mode renders natively is exactly what its registry holds: a registered tag renders through its handler, a
 * declared variant renders with it, and everything else takes a fallback. Envelope tags follow the same rule — a mode
 * that declares `title` as an envelope tag receives a root `<title>` in {@link Envelope.title}. No per-chat state
 * changes the answer.
 */

import type { ButtonCallback, CheckCallback, Element, SelectCallback, Tag, VariantOf } from '@deepseek-ai/satori-element'
import type { Bot, SendOptions } from './bot.ts'
import type { DegradationCosts } from './degradation.ts'
import type { LimitViolation } from './errors.ts'
import type { RenderReport } from './fallback.ts'
import type { Target } from './protocol.ts'
import type { ElementRegistry, RenderContext } from './registry.ts'
import type { Prepared } from './resource.ts'

/**
 * Static bounds a mode declares.
 *
 * - `limit.payload.bytes` / `limit.elements` / `limit.text.chars`: size of one draft (`check()` reports violations);
 * - `limit.buttons.row` / `limit.buttons.rows`: keyboard shape;
 * - `limit.update.count`: in-place edits one published message accepts;
 * - `limit.stream.interval`: minimum interval between stream ticks (ms);
 * - `limit.message.parts`: platform messages one logical message may use;
 * - `limit.delete.window`: how long after publication a message can still be deleted (ms).
 */
export type LimitKey =
  | 'limit.text.chars' | 'limit.payload.bytes' | 'limit.elements' | 'limit.buttons.row' | 'limit.buttons.rows'
  | 'limit.update.count' | 'limit.stream.interval' | 'limit.message.parts' | 'limit.delete.window'

export interface ModeTypes {
  /** Platform node produced by element handlers (adapter-defined union). */
  node: unknown
  /** One platform message before resource resolution. */
  draft: unknown
  /** Exact request body for one platform message. */
  payload: unknown
  /** Incremental update op for streaming (only modes with diff()). */
  patch?: unknown
}

export type ElementHandler<T extends ModeTypes, K extends Tag> =
  (el: Element<K>, ctx: RenderContext<T>) => T['node'] | readonly T['node'][]

export interface HandlerOptions<K extends Tag> {
  /** Variants this handler renders natively; others go to the fallback for that variant. */
  variants?: readonly VariantOf<K>[]
}

export interface Envelope {
  /** From `<quote id>`. */
  quote?: string
  /** From a root `<title>`, when the registry declares `title` as an envelope tag. */
  title?: Element<'title'>
}

/**
 * One in-process interaction callback a mode's handlers collected from the rendered elements: an `onClick` of a
 * `button[type=action|submit]`, an `onSelect` of a `select`, or an `onChange` of a checkbox `input` — registered by the
 * send stage under its id so the platform event of that id reaches it.
 */
export type InteractionAction =
  | { kind: 'button'; id: string; callback: ButtonCallback }
  | { kind: 'select'; id: string; callback: SelectCallback }
  | { kind: 'check'; id: string; callback: CheckCallback }

export interface TransformResult<D> {
  /** ≥ 1, in send order. */
  msgs: D[]
  /** From `<quote id>`. */
  quote?: string
  /** Interactions of the rendered tree, registered by the send stage. */
  actions: InteractionAction[]
  report: RenderReport
}

/** Pure context of `Mode.serialize`. */
export interface SerializeContext {
  readonly bot: Bot
  readonly target: Target
  readonly mode: string
  /** Index of this draft within the logical message, and the number of drafts. */
  readonly index: number
  readonly count: number
  /** Reply target (present for every part; the adapter decides which parts carry it). */
  readonly quote?: string
  readonly options: SendOptions
}

export interface Mode<T extends ModeTypes = ModeTypes> {
  readonly id: string
  readonly elements: ElementRegistry<T, any>
  readonly limits: Partial<Record<LimitKey, number>>
  /** What degrading an element costs this mode when core chooses one; defaults live in `degradation.ts`. */
  readonly degradation?: DegradationCosts
  /** Group nodes into platform messages: split media, hoist buttons, enforce limits (may degrade + report). */
  assemble(nodes: T['node'][], envelope: Envelope, ctx: RenderContext<T>): T['draft'][]
  serialize(msg: Prepared<T['draft']>, ctx: SerializeContext): T['payload']
  /** Streaming: diff two drafts of the same message. 'replace' = needs a whole-message update. */
  diff?(prev: T['draft'], next: T['draft']): T['patch'][] | 'replace'
  /** Hard platform limits of one draft (bytes, elements); violations trigger stream fallback or recall-and-resend. */
  check?(msg: T['draft']): LimitViolation[]
}

export type BaseTags = 'text' | 'p' | 'br'
export type MissingBase<R extends Tag> = [Exclude<BaseTags, R>] extends [never] ? unknown : { missingBaseTags: Exclude<BaseTags, R> }

/**
 * Compile-time checks: mandatory base tags (text, p, br) registered. Curried so that `T` is explicit while `R` is
 * inferred from the registry (single-call inference widens literal types in `assemble`).
 *
 * @example defineMode<PostTypes>()({ id: 'post', elements, limits, assemble, serialize })
 */
export function defineMode<T extends ModeTypes>(): <R extends Tag>(
  spec: Omit<Mode<T>, 'elements'> & { elements: ElementRegistry<T, R> } & MissingBase<R>,
) => Mode<T> {
  return spec => spec as Mode<T>
}
