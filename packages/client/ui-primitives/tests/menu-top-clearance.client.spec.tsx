/** The window fallback reserves desktop chrome while direct anchor placement keeps its normal gap. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/Menu.module.css', import.meta.url), 'utf8')

describe('Menu top clearance', () => {
  it('uses the frame overlay inset when no anchor-side placement fits', () => {
    const fallback = /@position-try --dsh-menu-window\s*\{([^}]+)\}/.exec(css)?.[1]
    expect(fallback).toBeDefined()
    expect(fallback).toMatch(/top:\s*var\(--dsh-menu-window-top\)/)
    expect(css).toMatch(/\.portal\s*\{[^}]*--dsh-menu-window-top:\s*max\(12px, var\(--dsh-frame-overlay-top, 12px\)\)/)
    expect(fallback).toMatch(/bottom:\s*12px/)
  })

  it('starts direct placement at the anchor with the normal four-pixel gap', () => {
    const portal = /\.portal\s*\{([^}]+)\}/.exec(css)?.[1]
    expect(portal).toBeDefined()
    expect(portal).toMatch(/position-area:\s*bottom span-right/)
    expect(portal).toMatch(/margin:\s*4px 0 0/)
    expect(portal).toMatch(/position-try-fallbacks:[^;]*flip-block[^;]*--dsh-menu-window/)
  })

  it('keeps pointer-menu height independent of desktop frame clearance', () => {
    const contextual = /\.list\[data-context-menu\]\.scrollable\s*\{([^}]+)\}/.exec(css)?.[1]
    expect(contextual).toBeDefined()
    expect(contextual).toContain('calc(100dvh - 24px)')
    expect(contextual).not.toContain('--dsh-frame-overlay-top')
    expect(css).toMatch(/\.portal\[data-context-menu\]\s*\{\s*--dsh-menu-window-top:\s*12px;/)
  })
})
