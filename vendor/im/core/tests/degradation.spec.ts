/**
 * The mode score: what one loss costs, so that losing bold never weighs as much as losing a picture.
 *
 * The suite pins every rule of the table in `degradation.ts`: the severe tags, the once-per-message price of inline
 * formatting, the dropped entry, the per-mode override and the forbidden loss.
 */
import { describe, expect, it } from 'vitest'
import { type Tag } from '@deepseek-ai/satori-element'
import {
  COST_FORBIDDEN, COST_INLINE, COST_PLAIN, COST_SEVERE, type DegradationCosts, degradationScore, createRenderReport,
  type RenderReport,
} from '@deepseek-ai/cordis-plugin-im-core'

/** A report that degrades `tags` and drops `dropped`. */
function report(degraded: Tag[], dropped: string[] = []): RenderReport {
  const value = createRenderReport()
  for (const tag of degraded) value.degraded.push({ tag, path: `message/${tag}[0]`, via: 'empty' })
  for (const what of dropped) value.dropped.push({ what, reason: 'unsupported' })
  return value
}

describe('degradationScore', () => {
  it('prices a clean render at zero', () => {
    expect(degradationScore(report([]))).toBe(0)
  })

  it('charges media, a mention and mid-message structure the severe cost', () => {
    for (const tag of ['img', 'audio', 'video', 'file', 'at', 'details', 'summary', 'button', 'button-group', 'table'] as const) {
      expect(degradationScore(report([tag]))).toBe(COST_SEVERE)
    }
    expect(degradationScore(report(['p', 'li', 'pre', 'blockquote']))).toBe(4 * COST_PLAIN)
  })

  it('charges the inline formatting of a message once, however many of them degrade', () => {
    expect(degradationScore(report(['b']))).toBe(COST_INLINE)
    expect(degradationScore(report(['b', 'i', 'u', 's', 'code', 'a']))).toBe(COST_INLINE)
    // … and separately from the rest of the report.
    expect(degradationScore(report(['b', 'img']))).toBe(COST_INLINE + COST_SEVERE)
  })

  it('charges a dropped element as severe, reading its tag from the report entry', () => {
    expect(degradationScore(report([], ['quote']))).toBe(COST_SEVERE)
    // A dropped interaction names its identity after the tag.
    expect(degradationScore(report([], ['button:stop']))).toBe(COST_SEVERE)
  })

  it('lets a mode override one price and forbid one loss', () => {
    const costs: DegradationCosts = { cost: { hr: COST_PLAIN }, forbidden: ['hr'] }
    // The override applies to a degraded element …
    expect(degradationScore(report(['hr']), { cost: { hr: COST_PLAIN } })).toBe(COST_PLAIN)
    // … while a forbidden tag costs enough that no other candidate can outbid it.
    expect(degradationScore(report(['hr']), costs)).toBe(COST_FORBIDDEN)
    expect(degradationScore(report([], ['hr']), { forbidden: ['hr'] })).toBe(COST_FORBIDDEN)
    // A forbidden tag applies to its own element only.
    expect(degradationScore(report(['p']), costs)).toBe(COST_PLAIN)
  })

  it('does not charge a folded panel', () => {
    const value = createRenderReport()
    value.folded = 3
    expect(degradationScore(value)).toBe(0)
  })
})
