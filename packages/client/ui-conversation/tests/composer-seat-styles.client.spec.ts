import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readStyles(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const conversationCss = readStyles('../src/client/skeleton/ConversationRoot.module.css')
const inputBarCss = readStyles('../src/client/skeleton/InputBar.module.css')
const contextMeterCss = readStyles('../src/client/skeleton/ContextMeter.module.css')

/** Return the body of the rule whose selector list starts with `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}[^{]*\\{([^}]*)\\}`).exec(css)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('docked composer seat styles', () => {
  const seat = rule(conversationCss, ".root[data-phase='active'] .composerSeat,")

  it('keeps the seat at one stacking rank in every state', () => {
    expect(seat).toMatch(/position:\s*sticky;/)
    expect(seat).toMatch(/z-index:\s*9;/)
    // No other rule ranks the seat, so opening a menu inside it changes nothing.
    const ranked = [...conversationCss.matchAll(/([^{}]*\.composerSeat[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => body !== undefined && /z-index/.test(body))
    expect(ranked).toHaveLength(1)
  })

  it('rests the seat at the floor without depending on a View to fill the column', () => {
    expect(seat).toMatch(/margin-top:\s*auto;/)
  })

  it('gives the seat a compositing reason that does not depend on overlap', () => {
    expect(seat).toMatch(/will-change:\s*transform;/)
  })

  it('keeps scroll anchoring off composer content', () => {
    expect(seat).toMatch(/overflow-anchor:\s*none;/)
  })
})

describe('composer statistics row styles', () => {
  it('reserves one reading row in the docked composer only', () => {
    expect(rule(inputBarCss, '.root:not(.hero) > .dock'))
      .toContain('min-height: calc(22px + var(--dsh-content-font-delta-secondary, 0px))')
    expect(rule(inputBarCss, '.hero .dock:empty')).toMatch(/display:\s*none;/)
  })

  it('sizes the reservation to one reading: a 20px secondary line plus 1px block padding', () => {
    const trigger = rule(contextMeterCss, '.trigger')
    expect(trigger).toContain('line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))')
    expect(trigger).toMatch(/padding:\s*1px 8px;/)
  })
})
