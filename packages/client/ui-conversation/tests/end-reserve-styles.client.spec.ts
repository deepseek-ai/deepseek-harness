/**
 * The Conversation body's end reserve as CSS text. jsdom has no layout, so
 * this reads the declarations that turn a requested reserve into the
 * scrollport's end inset and evaluates them around their boundaries; the Web
 * e2e suite measures the resulting layout.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Declarations of the rule with exactly this class selector, with whitespace collapsed. */
function declarationsOf(selector: string): Record<string, string> {
  const rule = new RegExp(`(?:^|[{}])\\s*\\${selector}\\s*\\{([^{}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`ConversationRoot.module.css has no \`${selector}\` rule`)
  return Object.fromEntries((rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean).map((part): [string, string] => {
    const colon = part.indexOf(':')
    return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()]
  }))
}

describe('Conversation body end reserve', () => {
  const body = declarationsOf('.body')

  it('derives the largest reserve and the inset from the scrollport width, the content width, and the side inset', () => {
    expect(body['--dsh-composer-side-clearance']).toBe('16px')
    expect(body['--dsh-chat-end-reserve-max']).toBe(
      'calc(var(--dsh-conversation-viewport-width, 0px) - 480px - var(--dsh-composer-side-clearance) - 16px)',
    )
    expect(body['--dsh-chat-end-inset']).toBe(
      'min(max(0px, calc((var(--dsh-chat-end-reserve-max) - var(--dsh-chat-end-reserve, 0px) + 1px) * 9999)),'
      + ' calc(2 * max(0px, var(--dsh-chat-end-reserve, 0px)'
      + ' - (var(--dsh-conversation-viewport-width, 0px) - var(--dsh-chat-content-width)) / 2)),'
      + ' max(0px, var(--dsh-chat-end-reserve, 0px) - var(--dsh-composer-side-clearance) - 16px))',
    )
  })

  it('moves the column aside by twice the missing gutter, then narrows it, and makes no room under a 480px column', () => {
    // The declarations above, evaluated for a scrollport `viewport` wide and a transcript `content` wide.
    const side = 32
    const inset = (viewport: number, content: number, reserve: number): number => Math.min(
      Math.max(0, (viewport - 480 - side - reserve + 1) * 9999),
      2 * Math.max(0, reserve - (viewport - content) / 2),
      Math.max(0, reserve - side),
    )
    /** The space after the column once the scrollport pads its end: the column keeps `side` at least on both sides. */
    const after = (viewport: number, content: number, reserve: number): number => {
      const frame = viewport - inset(viewport, content, reserve)
      const column = Math.min(content, frame - 2 * side)
      return viewport - (frame - column) / 2 - column
    }
    // No reserve, or a gutter that already holds it: no inset.
    expect([inset(1153, 742, 0), inset(1576, 880, 348), inset(2013, 880, 348)]).toEqual([0, 0, 0])
    // The start gutter lasts: the column keeps its width and the space after it is the reserve.
    expect(inset(1153, 742, 348)).toBe(285)
    expect(after(1153, 742, 348)).toBe(348)
    // The start gutter is down to the side inset: the column narrows, and the space after it stays the reserve.
    expect([inset(993, 680, 348), after(993, 680, 348)]).toEqual([316, 348])
    expect(993 - 316 - 2 * side).toBe(613)
    // The narrowest scrollport that makes room leaves a 480px column; one pixel less makes none.
    expect([inset(860, 680, 348), 860 - 316 - 2 * side]).toEqual([316, 480])
    expect(inset(859, 680, 348)).toBe(0)
  })

  it('pads the scrollport end by the inset and makes no room in an embedded occurrence', () => {
    expect(declarationsOf('.scrollBody')['padding-inline-end']).toBe('var(--dsh-chat-end-inset)')
    const embedded = declarationsOf('.embeddedBody')
    expect([embedded['--dsh-chat-end-reserve-max'], embedded['--dsh-chat-end-inset']]).toEqual(['0px', '0px'])
  })

  it('drops the width handles while the inset moves the column off the body center', () => {
    expect(declarationsOf('.widthHandle')['width']).toBe(
      'min(10px, calc((100% - var(--dsh-chat-content-width)) / 2 - 24px - 24px), calc(10px - var(--dsh-chat-end-inset) * 9999))',
    )
  })
})
