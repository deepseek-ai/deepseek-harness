/** Shared Button geometry and inset stroke declarations. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Button.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`Button.module.css has no .${selector} rule`)
  return rule[1] ?? ''
}

describe('Button styles', () => {
  it('retains a transparent layout border and paints the DPR-aware stroke inside it', () => {
    const outline = declarations('outline')
    expect(outline).toContain('border: 0.5px solid transparent;')
    expect(outline).toContain('box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px)')
    expect(outline).toContain('var(--dsh-button-outline-color, var(--dsw-alias-border-l3))')
  })

  it('limits the inset stroke to outlined buttons', () => {
    for (const selector of ['button', 'primary', 'ghost:hover:not(:disabled)', 'toolbar']) {
      expect(declarations(selector)).not.toContain('box-shadow')
    }
    expect(declarations('outline:hover:not(:disabled)')).not.toContain('box-shadow')
  })

  it('keeps the shared medium and small control heights', () => {
    expect(declarations('md')).toContain('height: 36px;')
    expect(declarations('sm')).toContain('height: 28px;')
  })
})
