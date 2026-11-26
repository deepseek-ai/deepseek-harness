import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXEMPT_PATHS, findThemeAttributeUses, isScannedSource, scanThemeAttributes } from './verify-theme-attributes.ts'

const root = resolve(import.meta.dirname, '..')

describe('verify-theme-attributes', () => {
  it('rejects the attribute names in selectors and scripts, and their dataset spellings', () => {
    const css = '.card { color: red }\n:global(body[data-ds-dark-theme]) .card { color: blue }\n'
    expect(findThemeAttributeUses('packages/client/ui-x/src/client/a.module.css', css))
      .toEqual([{ file: 'packages/client/ui-x/src/client/a.module.css', line: 2, name: 'data-ds-dark-theme' }])
    const ts = [
      "const dark = document.body.hasAttribute('data-ds-dark-theme')",
      "observer.observe(document.documentElement, { attributeFilter: ['data-ds-theme-source'] })",
      'const source = document.documentElement.dataset.dsThemeSource ?? document.body.dataset.dsDarkTheme',
    ].join('\n')
    expect(findThemeAttributeUses('a.ts', ts).map(use => [use.line, use.name])).toEqual([
      [1, 'data-ds-dark-theme'], [2, 'data-ds-theme-source'], [3, 'dsThemeSource'], [3, 'dsDarkTheme'],
    ])
  })

  it('accepts light-dark() colors and the useTheme standard prop', () => {
    expect(findThemeAttributeUses('a.module.css', '.card { --stroke: light-dark(var(--a), var(--b)) }')).toEqual([])
    expect(findThemeAttributeUses('a.tsx', "const dark = useTheme(s => s.active.colorScheme) === 'dark'")).toEqual([])
  })

  it('scans feature plugin sources and experimental packages with a Client half, but not the theme owners', () => {
    const experimental = new Set(['forge'])
    expect(isScannedSource('packages/client/ui-workspace/src/client/rows/Rows.module.css', experimental)).toBe(true)
    expect(isScannedSource('packages/client/ui-workspace/src/client/rows/Rows.tsx', experimental)).toBe(true)
    expect(isScannedSource('packages/experimental/forge/src/client/a.ts', experimental)).toBe(true)
    expect(isScannedSource('packages/experimental/headless/src/a.ts', experimental)).toBe(false)
    expect(isScannedSource('packages/client/ui-workspace/tests/rows.client.spec.tsx', experimental)).toBe(false)
    expect(isScannedSource('packages/client/ui-workspace/README.md', experimental)).toBe(false)
    expect(isScannedSource('packages/client/web/src/boot-page.module.css', experimental)).toBe(false)
    expect(isScannedSource('packages/client/ui-theme/src/styles/design-platform.css', experimental)).toBe(false)
    expect(isScannedSource('packages/client/ui-layout/src/client/theme-presenter.ts', experimental)).toBe(false)
    expect(isScannedSource('packages/client/ui-layout/src/client/AppFrame.tsx', experimental)).toBe(true)
    expect(EXEMPT_PATHS).toEqual(['packages/client/ui-theme/', 'packages/client/ui-layout/src/client/theme-presenter.ts'])
  })

  it('finds no use in the repository', () => {
    expect(scanThemeAttributes(root)).toEqual([])
  })
})
