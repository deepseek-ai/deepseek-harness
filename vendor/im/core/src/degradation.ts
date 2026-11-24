/**
 * What one loss costs when core chooses a mode.
 *
 * Counting degraded elements one by one treats losing a `<b>` exactly like losing a picture, which is not what a reader
 * experiences. The score therefore weighs every loss:
 *
 * - **media** (`img`, `audio`, `video`, `file`) and **`<at>`** cost {@link COST_SEVERE}: a lost picture or mention
 *   makes the message wrong, not merely plainer.
 * - **mid-message structure** (`details`, `summary`, `button`, `button-group`, `table`) costs the same: a fallback
 *   there reflows everything after it, and an interactive control that turns into text is gone.
 * - **inline formatting** (`b`, `i`, `u`, `s`, `code`, `a`) is charged **once for the whole group**, the price of one
 *   `<p>`: losing bold or a link is cosmetic, and a mode must not lose a heavy element just because it also renders
 *   text plainly.
 * - everything else costs {@link COST_PLAIN}.
 * - a **dropped** entry (an element the mode skips outright, e.g. an action button without a text equivalent) costs
 *   {@link COST_SEVERE}: losing content is never cosmetic.
 * - a mode may declare an element **forbidden** (Lark's post mode must not lose `<hr>`): such a loss costs
 *   {@link COST_FORBIDDEN}, which is large enough that the mode is chosen only when every candidate loses it.
 *
 * - a `<fallback>` that rendered its candidate *n* (0-based) costs *n* × {@link COST_PLAIN}: the author ranked the
 *   candidates, so a mode that renders an earlier one wins over a mode that needs a later one.
 * - **moved** elements cost {@link COST_PLAIN} each: a mode that keeps them out of the body breaks the flow the content
 *   asked for, which is what lets a mode able to keep them win without outranking it in the declared order.
 *
 * `RenderReport.folded` is deliberately not charged: a folded panel keeps its content one click away, and only card
 * mode folds at all, so counting it would penalise the mode for staying inside the platform's element budget.
 *
 * @module @deepseek-ai/cordis-plugin-im-core/degradation
 */

import type { Tag } from '@deepseek-ai/satori-element'
import type { RenderReport } from './fallback.ts'

/** Cost of losing an ordinary element (`<p>`, `<li>`, `<pre>`, …). The unit of the score. */
export const COST_PLAIN = 1
/** Cost of losing the inline formatting of a message, charged once however many of them degrade. */
export const COST_INLINE = 1
/** Cost of losing media, a mention, or mid-message structure. */
export const COST_SEVERE = 5
/** Cost of losing an element the mode declares forbidden; only reachable when no candidate keeps it. */
export const COST_FORBIDDEN = 1_000

/** Elements whose loss breaks the message rather than restyling it. */
const SEVERE_TAGS: readonly Tag[] = ['img', 'audio', 'video', 'file', 'at', 'details', 'summary', 'button', 'button-group', 'table']

/** Inline formatting: cheap, and priced as one group. */
const INLINE_TAGS: readonly Tag[] = ['b', 'i', 'u', 's', 'code', 'a']

/**
 * Cost rules a mode declares on top of the core defaults.
 *
 * Both fields are optional: {@link cost} overrides one tag's price (QQ prices a lost `<hr>` at {@link COST_PLAIN}
 * instead of refusing it) and {@link forbidden} refuses a loss the mode must not make.
 */
export interface DegradationCosts {
  /** Elements this mode must not degrade (Lark: `<hr>` is a real divider, not a paragraph break). */
  readonly forbidden?: readonly Tag[]
  /** Per-tag price overrides. */
  readonly cost?: Partial<Record<Tag, number>>
}

/** Default price of one degraded tag. */
function defaultCost(tag: Tag): number {
  return SEVERE_TAGS.includes(tag) ? COST_SEVERE : COST_PLAIN
}

/**
 * The score of one render: lower is better, `undefined` behaviour is left to the caller.
 *
 * @param report - the render report of one mode for one content tree.
 * @param costs - the rules that mode declares (`Mode.degradation`).
 * @returns the weighted cost of every loss in that report.
 */
export function degradationScore(report: RenderReport, costs: DegradationCosts = {}): number {
  const forbidden = new Set<Tag>(costs.forbidden ?? [])
  let score = 0
  let inline = false
  for (const entry of report.degraded) {
    if (forbidden.has(entry.tag)) score += COST_FORBIDDEN
    else if (INLINE_TAGS.includes(entry.tag)) inline = true
    else score += costs.cost?.[entry.tag] ?? defaultCost(entry.tag)
  }
  if (inline) score += COST_INLINE
 // An element the mode had to lift out of the message body costs the same as losing it there: the reader gets text,
 // picture, text as separate bubbles, and on a platform that prices each one (a passive reply) it is not free either.
  for (const entry of report.moved) score += costs.cost?.[entry.tag] ?? COST_PLAIN
  for (const entry of report.fallbacks) score += entry.candidate * COST_PLAIN
  for (const entry of report.dropped) {
    // `what` is a tag name (`quote`) or a tag and an identity (`button:stop`), so the price lookup reads the first part.
    const tag = entry.what.split(':')[0] as Tag
    score += forbidden.has(tag) ? COST_FORBIDDEN : costs.cost?.[tag] ?? COST_SEVERE
  }
  return score
}
