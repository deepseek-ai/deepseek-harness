/**
 * MarqueeText's clipping, travel, and fade masks as CSS text: the component
 * suite sees CSS Modules as class-name maps, so only the stylesheet proves that
 * a marqueeing text drops its ellipsis, travels by the measured distance and
 * time, and fades the edges that still hide text.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../src/Marquee.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/.exec(source)?.[1] ?? ''
const base = source.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}\s*$/, '')

function declarations(css: string, selector: string): Map<string, string> {
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

const START_FADE = 'linear-gradient(to right, transparent, #000 12px)'

describe('Marquee.module.css', () => {
  it('clips one line with an ellipsis at rest, with the travelling span inline so the ellipsis cuts between characters', () => {
    const rest = declarations(base, '.text')
    expect([rest.get('overflow'), rest.get('text-overflow'), rest.get('white-space')]).toEqual(['hidden', 'ellipsis', 'nowrap'])
    expect(declarations(base, '.travel').size).toBe(0)
  })

  it('drops the ellipsis and fades both edges while the text travels, then only the start edge once the travel time has passed', () => {
    const travelling = declarations(base, '.text[data-marquee]')
    expect(travelling.get('text-overflow')).toBe('clip')
    expect(travelling.get('mask-image')).toBe('linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent)')
    expect(travelling.get('animation')).toBe('dsh-marquee-arrive 0s var(--dsh-marquee-duration) forwards')
    expect(base.replace(/\s+/g, ' ')).toContain(`@keyframes dsh-marquee-arrive { to { mask-image: ${START_FADE}; } }`)
  })

  it('carries the span over the measured distance in the measured time at a constant speed and holds the far edge', () => {
    const travel = declarations(base, '.text[data-marquee] > .travel')
    expect(travel.get('display')).toBe('inline-block')
    expect(travel.get('animation')).toBe('dsh-marquee-travel var(--dsh-marquee-duration) linear forwards')
    expect(base.replace(/\s+/g, ' ')).toContain('@keyframes dsh-marquee-travel { to { transform: translateX(calc(-1 * var(--dsh-marquee-range))); } }')
  })

  it('shows the far edge at once under reduced motion, with the start fade alone', () => {
    const text = declarations(reduced, '.text[data-marquee]')
    expect([text.get('mask-image'), text.get('animation')]).toEqual([START_FADE, 'none'])
    const travel = declarations(reduced, '.text[data-marquee] > .travel')
    expect([travel.get('animation'), travel.get('transform')]).toEqual(['none', 'translateX(calc(-1 * var(--dsh-marquee-range)))'])
  })
})
