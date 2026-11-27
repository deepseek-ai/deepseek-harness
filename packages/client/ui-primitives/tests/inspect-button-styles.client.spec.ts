/**
 * InspectButton's hover-reveal rule as CSS text. CSS Modules resolve to
 * class-name maps in the component suite, so a missing reveal rule leaves the
 * pill invisible in every tool row while the component test still passes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/InspectButton.module.css', import.meta.url)), 'utf8')
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('InspectButton.module.css', () => {
  it('hides the pill until a pointer reaches its row', () => {
    expect(declarationText).toMatch(/\.button \{[^}]*opacity: 0;/)
    expect(declarationText).toMatch(/\[data-inspect-scope\]:hover \.button \{\s*opacity: 1;/)
  })

  it('keeps the pill visible for keyboard focus and touch-only devices', () => {
    expect(declarationText).toMatch(/\.button:focus-visible \{\s*opacity: 1;/)
    expect(declarationText).toMatch(/@media \(hover: none\) \{\s*\.button \{ opacity: 1; \}/)
  })

  it('keeps the capsule geometry and its solid hover fill', () => {
    expect(declarationText).toMatch(/\.button \{[^}]*border-radius: 999px;/)
    expect(declarationText).toMatch(/\.button:hover \{\s*background: var\(--dsw-alias-interactive-bg-hover-solid\);/)
  })
})
