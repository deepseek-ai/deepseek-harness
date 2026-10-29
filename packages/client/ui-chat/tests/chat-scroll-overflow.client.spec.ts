/** The transcript scroller never exposes horizontal scrollable overflow. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('Transcript scroll overflow', () => {
  it('clips the horizontal axis in both scrollport modes', () => {
    // The text-interaction surface is absolutely positioned inside the message
    // column and can reach past its right edge; an `auto` horizontal axis turns
    // that into a scroll range whose appearance and resolution jitter the
    // transcript while the tail is pinned.
    const css = read('ChatView.module.css')
    expect(rule(css, '.scroll')).toMatch(/overflow-x:\s*clip/)
    expect(rule(css, ':global([data-conversation-scroll]) .scroll')).toMatch(/overflow-x:\s*clip/)
  })
})
