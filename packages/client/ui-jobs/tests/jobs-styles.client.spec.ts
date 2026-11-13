/**
 * Job row geometry as CSS text: CSS Modules resolve to class-name maps in the
 * component suite, so only the stylesheet proves that the chevron leaves its
 * presses to the row button, including once the open chevron rotates, and that
 * a row keeps one 28px line.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/JobsSection.module.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (match === null) throw new Error(`JobsSection.module.css has no ${selector} rule`)
  return match[1] ?? ''
}

describe('JobsSection.module.css', () => {
  it('lets presses on the chevron reach the row button beneath it', () => {
    expect(rule('.chevron')).toMatch(/pointer-events:\s*none/)
    expect(rule('.chevronOpen')).toMatch(/transform:\s*rotate\(180deg\)/)
  })

  it('keeps a job on one 28px line, with the stop target overhanging it', () => {
    expect(rule('.rowLine')).toMatch(/min-height:\s*28px/)
    expect(rule('.rowLine')).toMatch(/padding:\s*4px 6px/)
    expect(rule('.label')).toMatch(/line-height:\s*20px/)
    expect(rule('.stop')).toMatch(/height:\s*24px/)
    expect(rule('.stop')).toMatch(/margin:\s*-2px -4px/)
  })

  it('keeps the 28px line while the stop control is armed, its pill filling the row padding', () => {
    expect(rule('.stopArmed')).toMatch(/height:\s*20px/)
    expect(rule('.stopArmed')).toMatch(/margin:\s*0;/)
    expect(rule('.stopArmed')).toMatch(/padding:\s*0 6px/)
    expect(rule('.stopLabel')).toMatch(/line-height:\s*18px/)
  })
})
