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
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('Chat aside layer', () => {
  it('spans the frame at zero height and passes pointer events through', () => {
    expect(declarationsOf('.asideSlot')).toEqual(expect.arrayContaining([
      'position: absolute', 'right: 0', 'left: 0', 'height: 0', 'pointer-events: none',
    ]))
  })

  it('publishes the end gutter as half the frame width the transcript column leaves, never negative', () => {
    expect(declarationsOf('.asideSlot')).toContain(
      '--dsh-chat-aside-gutter: max(0px, calc((100% - var(--dsh-chat-content-width, 100%)) / 2))',
    )
  })
})
