/** CSS activity and reduced-motion rules that jsdom does not execute. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/TextShimmer.module.css', import.meta.url), 'utf8')

describe('TextShimmer styles', () => {
  it('animates active text and disables motion and transparent fill for reduced motion', () => {
    expect(css).toMatch(/\.root\[data-text-shimmer\]\s*\{[^}]*animation: dsh-text-shimmer/s)
    expect(css).toMatch(/@keyframes dsh-text-shimmer\s*\{[^}]*background-position: 0% center/s)
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.root\[data-text-shimmer\]\s*\{([^}]+)\}/.exec(css)?.[1]
    expect(reduced).toContain('background-image: none;')
    expect(reduced).toContain('-webkit-text-fill-color: currentColor;')
    expect(reduced).toContain('animation: none;')
  })
})
