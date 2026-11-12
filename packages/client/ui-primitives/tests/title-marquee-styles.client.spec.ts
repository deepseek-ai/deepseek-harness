/**
 * The title marquee's fade masks as CSS text. CSS Modules resolve to class-name maps in the component suites, so only
 * the stylesheet can show that each clipping edge fades while the title travels.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/TitleMarquee.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** The mask image of the rule for one exact selector, with whitespace collapsed. */
function mask(selector: string): string | undefined {
  for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.trim() !== selector) continue
    return /mask-image:\s*([^;]+);/.exec(body)?.[1]?.replace(/\s+/g, ' ').trim()
  }
  return undefined
}

describe('TitleMarquee.module.css', () => {
  it('fades the left edge once the title left its start, the right while text remains beyond it, and both mid-travel', () => {
    expect(mask('.marquee[data-scrolled]')).toBe('linear-gradient(to right, transparent, #000 12px)')
    expect(mask('.marquee[data-clipped]')).toBe('linear-gradient(to left, transparent, #000 12px)')
    expect(mask('.marquee[data-scrolled][data-clipped]'))
      .toBe('linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)')
  })
})
