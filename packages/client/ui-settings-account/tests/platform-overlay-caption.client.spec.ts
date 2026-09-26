/**
 * The Windows caption clearance as CSS text. jsdom has no layout, so the
 * Account specs pin the return bar's DOM but cannot show where it lands; this
 * reads the declaration that keeps the Desktop-owned Application and Edit menu
 * from covering the return bar.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/PlatformOverlay.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ' '))
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

it('starts the return bar below the Desktop caption strip on Windows', () => {
  // The strip and its clearance token both come from the Desktop preload's
  // caption marker; without the offset the 48px return bar renders inside the
  // strip that the fixed caption menu host also occupies.
  expect(declarations(':global([data-windows-titlebar]) .overlay')).toContain('padding-top: var(--dsh-windows-titlebar-height)')
})
