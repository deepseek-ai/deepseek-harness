/** The page stylesheet reads only theme tokens ui-theme defines, so no value silently falls back. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../src/client/WebSearchCard.module.css')
/** The global sheets that define `--dsw-*` tokens: the design palette and the base scale. */
const theme = ['design-platform.css', 'base.css'].map(name => read(`../../ui-theme/src/styles/${name}`)).join('\n')

describe('WebSearchCard stylesheet', () => {
  it('references only defined theme tokens', () => {
    const used = [...new Set([...page.matchAll(/var\((--dsw-[\w-]+)/g)].map(match => match[1]!))]
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter(token => !theme.includes(`${token}:`))).toEqual([])
  })

  it('separates the sections by spacing, not hairlines', () => {
    expect(page.match(/\.section \+ \.section \{[^}]*\}/)?.[0]).not.toContain('border')
  })

  it('separates the provider menu block from the panel below it by spacing, not a hairline', () => {
    const field = page.match(/\.field \{[^}]*\}/)?.[0]
    expect(field).toContain('padding: 8px 0 12px;')
    expect(field).not.toContain('border')
    expect(page).not.toMatch(/\.field\s*\+/)
  })

  it('sets the settings below the provider menu on a gray panel', () => {
    expect(page).toMatch(/\.panel \{[^}]*background: var\(--dsw-alias-bg-module-platform\);/)
  })

  it('colors the provider list notice with the error state token', () => {
    expect(page).toMatch(/\.notice \{[^}]*color: var\(--dsw-alias-state-error-primary\);/)
  })
})
