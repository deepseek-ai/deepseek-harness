/** macOS sidebar column material in windowed and fullscreen states. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Selectors whose declarations set the sidebar column background.
 * @returns the selector text of each comma-separated part.
 */
function sidebarBackgroundSelectors(): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body = '']) => /(^|;)\s*background\s*:/u.test(body))
    .flatMap(([, selectorList = '']) => selectorList.split(',').map(value => value.trim()))
    .filter(selector => selector.endsWith('.sidebarCol'))
}

describe('AppFrame.module.css', () => {
  it('paints the macOS vibrancy tint only outside window fullscreen, where the Web sidebar fill remains', () => {
    const darwin = sidebarBackgroundSelectors().filter(selector => selector.includes("[data-platform='darwin']"))
    // The second entry is the prefers-reduced-transparency copy.
    expect(darwin).toEqual([
      ":global([data-platform='darwin']:not([data-fullscreen])) .frame:not([data-sidebar-drawer]) .sidebarCol",
      ":global([data-platform='darwin']:not([data-fullscreen])) .frame:not([data-sidebar-drawer]) .sidebarCol",
    ])
    expect(sidebarBackgroundSelectors()).toContain('.sidebarCol')
  })
})
