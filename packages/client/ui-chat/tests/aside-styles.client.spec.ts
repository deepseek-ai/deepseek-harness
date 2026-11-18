/**
 * The Chat aside layer as CSS text. jsdom has no layout, so the rendering
 * spec shows where the layer sits but not what it tells its occupant; this
 * reads the declarations an occupant's inline sizes depend on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/chat/ChatView.module.css', import.meta.url)), 'utf8')

function declarationsOf(selector: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(text)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()).filter(Boolean)
}

describe('Chat aside layer', () => {
  it('spans the frame at zero height and passes pointer events through', () => {
    expect(declarationsOf('.asideSlot')).toEqual(expect.arrayContaining([
      'position: absolute', 'right: 0', 'left: 0', 'height: 0', 'pointer-events: none',
    ]))
  })

  it('reaches across the Conversation body\'s end inset, so it spans the scrollport whatever room the body keeps free', () => {
    expect(declarationsOf('.asideSlot')).toContain('margin-inline-end: calc(-1 * var(--dsh-chat-end-inset, 0px))')
    // The margin animates with the scrollport's padding, so the layer's end edge stays put while the inset changes.
    expect(declarationsOf('.asideSlot')).toContain('transition: margin-inline-end var(--dsh-chat-end-reserve-transition, 0s)')
  })

  it('publishes the end gutter as the end inset plus half of what the transcript column leaves of the rest, never negative', () => {
    expect(declarationsOf('.asideSlot')).toContain(
      '--dsh-chat-aside-gutter: calc(var(--dsh-chat-end-inset, 0px)'
      + ' + max(0px, (100% - var(--dsh-chat-end-inset, 0px) - var(--dsh-chat-content-width, 100%)) / 2))',
    )
    // The declaration, evaluated for a layer `frame` wide: without an inset it is the centered column's gutter.
    const gutter = (frame: number, content: number, inset: number): number => inset + Math.max(0, (frame - inset - content) / 2)
    expect([gutter(1576, 880, 0), gutter(600, 880, 0)]).toEqual([348, 0])
    // An inset of twice the missing gutter leaves exactly the gutter asked for.
    expect(gutter(1153, 742, 2 * (348 - (1153 - 742) / 2))).toBe(348)
  })
})
