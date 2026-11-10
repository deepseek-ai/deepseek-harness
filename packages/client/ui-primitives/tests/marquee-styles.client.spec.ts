/**
 * MarqueeText's clipping and fade masks as CSS text: the component suite sees
 * CSS Modules as class-name maps, so only the stylesheet proves that a crawling
 * text drops its ellipsis and fades the edges that still hide text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Marquee.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found
}

describe('Marquee.module.css', () => {
  it('clips one line with an ellipsis at rest', () => {
    const rest = declarations('.text')
    expect([rest.get('overflow'), rest.get('text-overflow'), rest.get('white-space')]).toEqual(['hidden', 'ellipsis', 'nowrap'])
  })

  it('drops the ellipsis and fades whichever edge still hides text while it crawls', () => {
    expect(declarations('.text[data-scrolled]').get('text-overflow')).toBe('clip')
    expect(declarations('.text[data-clipped]').get('text-overflow')).toBe('clip')
    expect(declarations('.text[data-scrolled]').get('mask-image')).toBe('linear-gradient(to right, transparent, #000 12px)')
    expect(declarations('.text[data-clipped]').get('mask-image')).toBe('linear-gradient(to left, transparent, #000 12px)')
    expect(declarations('.text[data-scrolled][data-clipped]').get('mask-image'))
      .toBe('linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)')
  })
})
