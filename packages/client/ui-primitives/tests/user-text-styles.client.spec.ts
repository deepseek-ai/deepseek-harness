/**
 * UserText's font-size-axis adoption as CSS text. jsdom has no layout, so
 * this reads the declaration that keeps inline reference glyphs riding the
 * consumer's text size in both surfaces the projection serves (bubble and
 * queue preview).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/user-text.module.css', import.meta.url)), 'utf8')
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`user-text.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('user-text.module.css font-size axis', () => {
  it('scales reference glyphs with the consumer font', () => {
    expect(declarations('.refIcon')).toEqual(expect.arrayContaining([
      'width: 1em',
      'height: 1em',
    ]))
  })

  it('sets slash chips in the code face at the consumer size', () => {
    // Skill and command tokens read as code — the family the theme publishes
    // for code — while the size and line height stay the consumer's, so the
    // chip rides the bubble line like the plain runs around it.
    const slashChip = declarations('.slashChip')
    expect(slashChip.some(declaration => /^font-family: var\(--dsw-font-/.test(declaration))).toBe(true)
    expect(slashChip.some(declaration => /^(font|font-size|line-height):/.test(declaration))).toBe(false)
  })
})
