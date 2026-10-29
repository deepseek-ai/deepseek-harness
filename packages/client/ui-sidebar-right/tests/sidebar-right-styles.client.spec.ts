/** Right sidebar slide style contracts. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/shell/SidebarRight.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
const host = String.raw`:global\(\[data-dockkit-host='dock'\]\)`

describe('SidebarRight.module.css', () => {
  it('starts docked items mounted by an opening at the closed position', () => {
    expect(css).toMatch(new RegExp(String.raw`@starting-style\s*\{\s*\.panel\[data-sidebar-right-opening\] ${host},[^{}]*\{`
      + String.raw`\s*transform: translateX\(var\(--dsh-sidebar-width\)\);\s*}\s*}`))
  })

  it('removes the open slide as well as the close slide for reduced motion', () => {
    expect(css).toMatch(new RegExp(String.raw`@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*`
      + String.raw`\.panel\[data-sidebar-right-open\] ${host}[^{}]*\{\s*transition: none;\s*}`))
  })
})
