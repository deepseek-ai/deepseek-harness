/** macOS sidebar column material in windowed and fullscreen states. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
const column = ":global([data-platform='darwin']) .frame:not([data-sidebar-drawer]) .sidebarCol"
const fullscreen = ":global([data-platform='darwin'][data-fullscreen]) .frame:not([data-sidebar-drawer]) .sidebarCol"
const fillLayer = 'linear-gradient(var(--dsh-sidebar-fullscreen-fill), var(--dsh-sidebar-fullscreen-fill))'

/**
 * Read the first rule for an exact selector, independently of CSS-module names.
 * @param selector - Selector whose declarations are inspected.
 * @param declaration - Optional declaration fragment for selectors with multiple rules.
 * @returns Whitespace-normalized declarations, or undefined when absent.
 */
function rule(selector: string, declaration = ''): string | undefined {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectors = '', body = '']) => [selectors, body.trim().replace(/\s+/g, ' ')] as const)
    .find(([selectors, body]) => body.includes(declaration) && selectors.split(',').some(value => value.trim() === selector))?.[1]
}

/**
 * The body of every block of one at-rule.
 * @param prelude - The at-rule text before its block.
 * @returns The concatenated block bodies.
 */
function atRule(prelude: string): string {
  return [...css.matchAll(new RegExp(`${prelude.replace(/[()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`, 'gu'))].map(([, body]) => body).join(' ')
}

describe('AppFrame.module.css', () => {
  it('paints a transparent fill layer over the glass outside fullscreen and the Web sidebar fill inside it', () => {
    const material = rule(column, 'background:')
    expect(material).toContain('--dsh-sidebar-fullscreen-fill: transparent;')
    expect(material).toContain(`background: ${fillLayer}, linear-gradient(`)
    expect(material).toContain('var(--dsw-specific-sidebar-tint);')
    expect(rule(fullscreen)).toBe('--dsh-sidebar-fullscreen-fill: var(--dsw-specific-sidebar-fill);')
    expect(rule('.sidebarCol')).toContain('background: var(--dsw-specific-sidebar-fill);')
  })

  it('transitions the registered fill color without positioning the column', () => {
    expect(rule('@property --dsh-sidebar-fullscreen-fill')).toBe("syntax: '<color>'; inherits: false; initial-value: transparent;")
    const material = rule(column, 'background:')
    expect(material).toContain('transition: --dsh-sidebar-fullscreen-fill var(--ds-transition-duration) var(--ds-ease-in-out);')
    expect(material).not.toMatch(/position|isolation|z-index/u)
    expect(css).not.toContain('.sidebarCol::before')
  })

  it('keeps the fill layer over the reduced-transparency backing', () => {
    const reduced = atRule('@media (prefers-reduced-transparency: reduce)')
    expect(reduced).toContain(column)
    expect(reduced.replace(/\s+/g, ' ')).toContain(`background: ${fillLayer}, color-mix(in srgb, var(--dsw-specific-sidebar-fill) 90%, transparent);`)
  })

  it('switches the fill immediately when reduced motion is requested', () => {
    expect(atRule('@media (prefers-reduced-motion: reduce)').replace(/\s+/g, ' ')).toContain(`${column} { transition: none; }`)
  })
})
