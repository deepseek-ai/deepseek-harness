import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SkillRow.module.css', import.meta.url)), 'utf8')
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`SkillRow.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('SkillRow.module.css summary line', () => {
  it('uses the shared ToolCall secondary font-size axis', () => {
    for (const selector of ['.title', '.summary']) {
      expect(declarations(selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
  })

  it('scales the collapsed row and business glyph with the global font delta', () => {
    expect(declarations('.row')).toEqual(expect.arrayContaining([
      'height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]))
    expect(declarations('.leading')).toEqual(expect.arrayContaining([
      'width: calc(16px + var(--dsh-content-font-delta, 0px))',
      'height: calc(16px + var(--dsh-content-font-delta, 0px))',
    ]))
    expect(declarations('.leading svg')).toEqual(expect.arrayContaining([
      'width: calc(14px + var(--dsh-content-font-delta, 0px))',
      'height: calc(14px + var(--dsh-content-font-delta, 0px))',
    ]))
  })
})
