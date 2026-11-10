/**
 * Job row geometry as CSS text: CSS Modules resolve to class-name maps in the
 * component suite, so only the stylesheet proves that the chevron leaves its
 * presses to the row button, including once the open chevron rotates.
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
})
