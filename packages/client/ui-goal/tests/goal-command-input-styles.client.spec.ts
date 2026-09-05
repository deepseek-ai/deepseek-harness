/**
 * The command-input bubble's typography as CSS text. jsdom has no layout, so
 * this reads the declarations that make the bubble share the user bubble's
 * face and size axis: the shared projection sets the `/goal` chip in the code
 * face, so the bubble itself must not pin a different family.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/GoalCommandInputView.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`GoalCommandInputView.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('GoalCommandInputView.module.css typography', () => {
  it('types the command bubble like the user bubble: no family override, same size axis', () => {
    const bubble = declarations('.bubble')
    expect(bubble.some(declaration => /^font(-family)?:/.test(declaration))).toBe(false)
    expect(bubble).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size, 14px)',
      'line-height: calc(22px + var(--dsh-content-font-delta, 0px))',
    ]))
  })
})
