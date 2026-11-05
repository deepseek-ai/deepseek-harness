/** Settings carrier geometry is independent of contributed launcher markup. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8')

it('keeps the indicator carrier full-width without inspecting account state', () => {
  expect(css).toMatch(/\.triggerRow\s*\{[^}]*width: 100%;[^}]*margin: 4px 0;/)
  expect(css).not.toContain('data-signed-out')
  expect(css).toMatch(/\.triggerRow\.railRow\s*\{[^}]*width: 36px;/)
})
