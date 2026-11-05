/** Account-owned sidebar spacing and total control heights. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AccountMenu.module.css', import.meta.url), 'utf8')

it('insets only the account root without resizing the settings carrier', () => {
  expect(css).toMatch(/\.root\[data-inset='true'\]\s*\{\s*margin-inline: 2px;\s*\}/)
  expect(css).toMatch(/\.root\s*\{[^}]*flex: 1;[^}]*min-width: 0;/)
})

it('includes padding and borders in the 44px account and 32px More rows', () => {
  const trigger = css.match(/\.trigger\s*\{([^}]+)\}/)?.[1]
  expect(trigger).toContain('box-sizing: border-box;')
  expect(trigger).toContain('height: 44px;')
  expect(css).toMatch(/\.trigger\[data-signed-out='true'\]:not\(\[data-collapsed='true'\]\)\s*\{[^}]*height: 32px;/)
  expect(css).toMatch(/\.trigger\[data-collapsed='true'\]\s*\{[^}]*width: 36px;[^}]*height: 36px;/)
})
