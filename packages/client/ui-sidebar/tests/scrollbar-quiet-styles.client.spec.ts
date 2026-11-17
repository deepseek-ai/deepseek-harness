/**
 * The quiet-column rule as CSS text: the state SidebarRoot toggles
 * (pointer-scrollbars.spec.tsx) hides a scrollbar only through this rule, and
 * ui-theme's gate checks the rebinding contract's shape without knowing which
 * sheet states which half.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')
/** Declarations only: the sheet's prose names the properties it explains. */
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * The quiet rule's declarations, trimmed.
 * @returns each declaration of `.root.quietBars` as written.
 */
function quietDeclarations(): string[] {
  const rule = /\.root\.quietBars\s*\{([^{}]*)\}/.exec(declarationText)
  expect(rule).not.toBeNull()
  return (rule![1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('SidebarRoot.module.css quiet column', () => {
  it('rebinds the ui-theme indirection pair to transparent', () => {
    // The pair, not the resting thumb alone: rebinding one leaves the other
    // painting its base-surface colour the moment the pointer reaches the bar.
    const declarations = quietDeclarations().filter(part => !part.startsWith('transition')).sort()
    expect(declarations).toEqual([
      '--dsh-scrollbar-thumb-hover: transparent',
      '--dsh-scrollbar-thumb: transparent',
    ].sort())
  })

  it('fades both halves of the pair out after a delay, and only on the way to quiet', () => {
    const transition = quietDeclarations().find(part => part.startsWith('transition:'))
    expect(transition?.replace(/\s+/g, ' ')).toBe(
      'transition: --dsh-scrollbar-thumb 200ms linear 500ms, --dsh-scrollbar-thumb-hover 200ms linear 500ms',
    )
    // A reveal has no transition: the base rule declares none.
    const base = /(?:^|\})\s*\.root\s*\{([^{}]*)\}/.exec(declarationText)
    expect(base).not.toBeNull()
    expect(base![1]).not.toMatch(/transition/)
  })

  it('keeps the delay and drops the fade under reduced motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/.exec(declarationText)
    expect(reduced?.[1]).toMatch(/\.root\.quietBars\s*\{\s*transition-duration:\s*0s;\s*\}/)
  })

  it('leaves the gutter reservation to the scrolling region', () => {
    // Hiding the thumb must not move a row: the reservation lives on the list
    // (ui-workspace), so the column states colour only.
    expect(declarationText).not.toMatch(/scrollbar-gutter/)
  })
})
