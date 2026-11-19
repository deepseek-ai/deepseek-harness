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

/** Declarations of the rule with exactly this selector, with whitespace collapsed. */
function declarationsOf(selector: string): Record<string, string> {
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\'=]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(css)
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
      'calc(var(--dsh-conversation-viewport-width) - var(--dsh-chat-content-width-resolved) - var(--dsh-composer-side-clearance) - 16px)',
    )
    expect(body['--dsh-chat-end-inset-resolved']).toBe(
      'min(max(0px, calc((var(--dsh-chat-end-reserve-max) - var(--dsh-chat-end-reserve, 0px)) * 10000000 + 1000px)),'
      + ' calc(2 * max(0px, var(--dsh-chat-end-reserve, 0px)'
      + ' - (var(--dsh-conversation-viewport-width) - var(--dsh-chat-content-width-resolved)) / 2)))',
    )
    expect(body['--dsh-chat-end-inset']).toBe('var(--dsh-chat-end-inset-resolved)')
  })

  it('keeps the continuously varying lengths on the body and publishes resolved lengths to its descendants', () => {
    // Registered without inheritance: a resize that changes them every frame does not restyle the transcript.
    const registered = Object.fromEntries([...css.matchAll(/@property\s+(--[\w-]+)\s*\{([^{}]*)\}/g)]
      .map((match): [string, string] => [match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' ').trim()]))
    expect(registered).toEqual({
      '--dsh-conversation-column-width': "syntax: '<length>'; inherits: false; initial-value: 0px;",
      '--dsh-conversation-viewport-width': "syntax: '<length>'; inherits: false; initial-value: 0px;",
      '--dsh-chat-user-width': "syntax: '*'; inherits: false;",
      '--dsh-chat-content-width-resolved': "syntax: '<length>'; inherits: false; initial-value: 0px;",
      '--dsh-chat-end-reserve-max': "syntax: '<length>'; inherits: false; initial-value: 0px;",
      '--dsh-chat-end-inset-resolved': "syntax: '<length>'; inherits: false; initial-value: 0px;",
    })
    // The inherited public names repeat a computed length, whose text changes only with the resolved width.
    expect(body['--dsh-chat-content-width-resolved']).toBe(
      'var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width) * 0.64), 880px))',
    )
    expect(body['--dsh-chat-content-width']).toBe('var(--dsh-chat-content-width-resolved)')
  })

  it('moves the column aside by twice the missing gutter at its own width, and makes no room once the start gutter is at the side inset', () => {
    // The declarations above, evaluated for a scrollport `viewport` wide and a transcript `content` wide.
    const side = 32
    const reserveMax = (viewport: number, content: number): number => viewport - content - side
    const inset = (viewport: number, content: number, reserve: number): number => Math.min(
      Math.max(0, (reserveMax(viewport, content) - reserve) * 10000000 + 1000),
      2 * Math.max(0, reserve - (viewport - content) / 2),
    )
    /** The space before and after the column once the scrollport pads its end. */
    const gutters = (viewport: number, content: number, reserve: number): [number, number] => {
      const frame = viewport - inset(viewport, content, reserve)
      const column = Math.min(content, frame - 2 * side)
      return [(frame - column) / 2, viewport - (frame + column) / 2]
    }
    // No reserve, or a gutter that already holds it: no inset.
    expect([inset(1153, 742, 0), inset(1576, 880, 348), inset(2013, 880, 348)]).toEqual([0, 0, 0])
    // A gutter one pixel short: the column moves by that pixel.
    expect([inset(1574, 880, 348), gutters(1574, 880, 348)]).toEqual([2, [346, 348]])
    expect([inset(1400, 880, 348), gutters(1400, 880, 348)]).toEqual([176, [172, 348]])
    // The narrowest scrollport that makes room leaves the column its side inset before it.
    expect([reserveMax(1260, 880), inset(1260, 880, 348), gutters(1260, 880, 348)]).toEqual([348, 316, [32, 348]])
    // One pixel less makes none: the column stays centered at its width.
    expect([inset(1259, 880, 348), gutters(1259, 880, 348)]).toEqual([0, [189.5, 189.5]])
    // A fraction of a pixel short makes none either: the inset is all or nothing.
    expect(inset(1259.96, 880, 348)).toBe(0)
    expect(inset(1260.04, 880, 348)).toBeCloseTo(315.96, 6)
    // A scrollport narrower than the content width has no reserve to give, with or without a request.
    expect([inset(600, 680, 348), inset(600, 680, 0)]).toEqual([0, 0])
  })

  it('pads the scrollport end by the inset and makes no room in an embedded occurrence', () => {
    expect(declarationsOf('.scrollBody')['padding-inline-end']).toBe('var(--dsh-chat-end-inset)')
    // The inset applies at once unless a stylesheet sets the transition for a change it wants animated.
    expect(declarationsOf('.scrollBody')['transition']).toBe('padding-inline-end var(--dsh-chat-end-reserve-transition, 0s)')
    const embedded = declarationsOf('.embeddedBody')
    expect([embedded['--dsh-chat-end-reserve-max'], embedded['--dsh-chat-end-inset']]).toEqual(['0px', '0px'])
  })

  it('moves each width handle with the column and sizes it from the gutter on its own side', () => {
    // Half the inset toward the start edge, as the column's center moves; the start gutter loses that half and the end gutter gains it.
    expect(declarationsOf(".widthHandle[data-side='left']")).toEqual({
      right: 'calc(50% + var(--dsh-chat-end-inset) / 2 + var(--dsh-chat-content-width) / 2 + 24px)',
      width: 'min(10px, calc((100% - var(--dsh-chat-end-inset) - var(--dsh-chat-content-width)) / 2 - 24px - 24px))',
    })
    expect(declarationsOf(".widthHandle[data-side='right']")).toEqual({
      left: 'calc(50% - var(--dsh-chat-end-inset) / 2 + var(--dsh-chat-content-width) / 2 + 24px)',
      width: 'min(10px, calc((100% + var(--dsh-chat-end-inset) - var(--dsh-chat-content-width)) / 2 - 24px - 24px))',
    })
    expect(declarationsOf('.widthHandle')['width']).toBeUndefined()
  })
})
