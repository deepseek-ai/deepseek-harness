/**
 * The compact HoverCard's placement as CSS text: the component suite sees CSS
 * Modules as class-name maps and jsdom lays out nothing, so only the stylesheet
 * proves which positions the browser tries, and in which order.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/HoverCard.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

describe('HoverCard.module.css', () => {
  it('places a compact card beside its anchor\'s end edge, top on the anchor\'s top, 8px from the anchor and the viewport', () => {
    expect(declarations('.card').get('position')).toBe('fixed')
    const compact = declarations('.compact')
    expect([compact.get('position-area'), compact.get('inset')]).toEqual(['inline-end span-block-end', '0 8px 8px'])
  })

  it('tries the start side, then a bottom-held card on either side, then below the anchor and above it, then the viewport\'s corner', () => {
    expect(declarations('.compact').get('position-try-fallbacks')).toBe(
      'flip-inline, --dsh-hover-card-low, --dsh-hover-card-low flip-inline, --dsh-hover-card-below, --dsh-hover-card-above, --dsh-hover-card-held',
    )
    const low = declarations('@position-try --dsh-hover-card-low')
    expect([low.get('position-area'), low.get('align-self')]).toEqual(['inline-end span-all', 'end'])
  })

  it('keeps a card that fits on neither side off its anchor: 8px below or above it, from the anchor\'s start edge', () => {
    const below = declarations('@position-try --dsh-hover-card-below')
    expect([below.get('position-area'), below.get('inset')]).toEqual(['block-end span-inline-end', '8px 8px 8px 0'])
    const above = declarations('@position-try --dsh-hover-card-above')
    expect([above.get('position-area'), above.get('inset')]).toEqual(['block-start span-inline-end', '8px 8px 8px 0'])
  })

  it('holds a card too tall to go below or above its anchor at the viewport\'s bottom and end margins, as the last fallback', () => {
    const held = declarations('@position-try --dsh-hover-card-held')
    expect([held.get('position-area'), held.get('justify-self'), held.get('align-self')]).toEqual(['span-all', 'end', 'end'])
  })
})
