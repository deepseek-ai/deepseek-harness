/**
 * The dropdown card's viewport cap as CSS text. CSS Modules resolve to
 * class-name maps in the component suites, so a missing or wrong declaration
 * leaves `atoms.client.spec.tsx` — which asserts placement and the
 * `scrollable` class — passing while the card still overflows a phone screen.
 * Only the stylesheet can prove which viewport unit caps it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Menu.module.css', import.meta.url)), 'utf8')

/** Every `max-height` value of the `.scrollable` rule, in source order. */
function maxHeights(): string[] {
  const rule = /\.scrollable\s*\{([^}]*)\}/.exec(css)
  if (rule === null) throw new Error('Menu.module.css has no .scrollable rule')
  return [...(rule[1] ?? '').matchAll(/max-height:\s*([^;]+);/g)].map(match => (match[1] ?? '').trim())
}

describe('Menu.module.css', () => {
  it('caps the scrolling list against the dynamic viewport, with a plain-vh fallback', () => {
    // The fallback first: a browser that drops `dvh` keeps the layout-viewport
    // cap, and mobile browser chrome can then only hide the card's far edge.
    expect(maxHeights()).toEqual([
      'min(calc(100vh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px))), var(--dsh-anchored-max-height, 100vh))',
      'min(calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px))), var(--dsh-anchored-max-height, 100vh))',
    ])
  })

  it('scrolls the rows inside the cap so the pinned footer stays visible', () => {
    expect(css).toMatch(/\.scrollable \.viewport \{[^}]*overflow-y: auto/)
  })
})
