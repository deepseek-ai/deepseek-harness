/** Pin controls use Session-action ink without changing the navigation control's dimensions. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/EntryMenu.module.css', import.meta.url), 'utf8')

describe('entry pin styling', () => {
  it('uses tertiary ink for both pin states and primary ink on pointer hover', () => {
    expect(css).toMatch(/\.pinButton\s*\{[^}]*color:\s*var\(--dsw-alias-label-tertiary\)/)
    expect(css).toMatch(/\.pinButton:hover\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary\)/)
    expect(css).not.toMatch(/\[data-pinned=['"]true['"]\]\s+\.pinButton\s*\{[^}]*color:/)
  })

  it('centers the pin without creating a transformed tooltip container', () => {
    const pinAnchor = css.match(/\.pinAnchor\s*\{([^}]*)\}/)?.[1]
    expect(pinAnchor).toBeDefined()
    expect(pinAnchor).toContain('align-items: center')
    expect(pinAnchor).not.toContain('transform:')
  })
})
