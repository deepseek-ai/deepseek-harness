import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(new URL('../src/Tooltip.module.css', import.meta.url), 'utf8')

describe('tooltip overflow styles', () => {
  it('wraps unbroken labels and bounds the complete bubble in both viewport dimensions', () => {
    expect(stylesheet).toContain('width: max-content;')
    expect(stylesheet).toContain('box-sizing: border-box;')
    expect(stylesheet).toContain('max-width: min(50vw, calc(100vw - 24px));')
    expect(stylesheet).toContain('max-height: calc(100vh - 24px);')
    expect(stylesheet).toContain('overflow-wrap: break-word;')
    expect(stylesheet).toContain('.label { min-width: 0; }')
  })

  it('keeps oversized content scrollable from its start when pinned', () => {
    expect(stylesheet).toContain('align-items: safe center;')
    expect(stylesheet).toContain('overflow: auto;')
    expect(stylesheet).toContain('.bubble[data-pinned] { pointer-events: auto; }')
  })

  it('uses the same vertical centering for left and right placements', () => {
    expect(stylesheet).toMatch(/\.bubble\[data-side='right'\],\s*\.bubble\[data-side='left'\]\s*\{\s*transform: translateY\(-50%\);/)
  })
})
