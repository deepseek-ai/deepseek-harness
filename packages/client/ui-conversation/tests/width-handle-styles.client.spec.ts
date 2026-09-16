import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationCss = readFileSync(fileURLToPath(new URL(
  '../src/client/skeleton/ConversationRoot.module.css',
  import.meta.url,
)), 'utf8')

/** Return one stylesheet rule body for an exact class selector. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 's').exec(css)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('conversation width handle styles', () => {
  it('keeps the gutter hit target narrow', () => {
    const handle = rule(conversationCss, '.widthHandle')
    expect(handle).toMatch(/width:\s*min\(\s*10px/)
  })

  it('keeps the hover indicator compact', () => {
    const indicator = rule(conversationCss, '.widthHandle::after')
    expect(indicator).toMatch(/width:\s*2px/)
    expect(indicator).toContain('var(--dsw-alias-scrollbar-bg-l1)')
    expect(indicator).not.toContain('var(--dsw-alias-scrollbar-hover-l1)')
    expect(indicator).toContain('var(--dsh-width-handle-pointer-y, 50%) - 36px')
    expect(indicator).toContain('var(--dsh-width-handle-pointer-y, 50%) + 36px')
  })

  it('keeps the indicator above the composer after drag capture begins', () => {
    expect(conversationCss).toMatch(/\.widthHandle\[data-dragging\]\s*\{[^}]*z-index:\s*8/s)
  })
})
