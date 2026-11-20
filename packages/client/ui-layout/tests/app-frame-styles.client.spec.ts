/** macOS sidebar column material in windowed and fullscreen states. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
const column = ":global([data-platform='darwin']) .frame:not([data-sidebar-drawer]) .sidebarCol"
const fullscreen = ":global([data-platform='darwin'][data-fullscreen]) .frame:not([data-sidebar-drawer]) .sidebarCol::before"

/**
 * Read the first rule for an exact selector, independently of CSS-module names.
 * @param selector - Selector whose declarations are inspected.
 * @param declaration - Optional declaration fragment for selectors with multiple rules.
 * @returns Whitespace-normalized declarations, or undefined when absent.
 */
function rule(selector: string, declaration = ''): string | undefined {
  return [...css.matchAll(/([^{}]+){([^{}]*)}/g)]
    .find(([, selectors = '', body = '']) => body.includes(declaration)
      && selectors.split(',').some(value => value.trim() === selector))?.[2]
    ?.trim().replace(/\s+/g, ' ')
}

describe('AppFrame.module.css', () => {
  it('keeps the glass backing mounted below fullscreen without changing Web or drawer fills', () => {
    expect(rule(column, 'background:')).toContain('linear-gradient(')
    expect(rule(column, 'background:')).toContain('var(--dsw-specific-sidebar-tint)')
    expect(rule(column, 'background:')).toContain('position: relative; isolation: isolate;')
    expect(rule('.sidebarCol')).toContain('background: var(--dsw-specific-sidebar-fill);')
    expect(css).not.toContain(":global([data-platform='darwin']:not([data-fullscreen])) .frame:not([data-sidebar-drawer]) .sidebarCol")
  })

  it('fades only the opaque backing without covering content or intercepting input', () => {
    expect(rule(`${column}::before`)).toBe([
      "content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;",
      'background: var(--dsw-specific-sidebar-fill); opacity: 0;',
      'transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out);',
    ].join(' '))
    expect(rule(fullscreen)).toBe('opacity: 1;')
    expect(rule(column, 'background:')).not.toContain('opacity:')
  })

  it('keeps the reduced-transparency backing underneath the same fullscreen fade', () => {
    const reduced = css.match(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/u)?.[1]
    expect(reduced).toContain(column)
    expect(reduced).toContain('background: color-mix(in srgb, var(--dsw-specific-sidebar-fill) 90%, transparent);')
  })

  it('switches the backing immediately when reduced motion is requested', () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/gu)]
      .map(([, body]) => body).join(' ')
    expect(reduced).toContain(`${column}::before {
    transition: none;`)
  })
})
