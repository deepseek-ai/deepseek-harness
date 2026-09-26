/**
 * StateDot's palette as CSS text. jsdom has no layout and CSS Modules resolve
 * to class-name maps in the component suites, so the only place the per-state
 * colors can be read is the stylesheet itself: a state whose rule is missing
 * renders on the inherited color instead of its own, which no render assertion
 * would catch.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/StateDot.module.css', import.meta.url)), 'utf8')

describe('StateDot.module.css', () => {
  it.each(['done', 'warning', 'error', 'idle'] as const)('gives the %s state its own color rule', (state) => {
    expect(css).toContain(`.dot[data-state='${state}']`)
  })

  it('renders solid states without a halo', () => {
    expect(css).not.toContain('.dot::before')
    expect(css).toContain('.dot::after')
  })

  it('uses success green for done', () => {
    expect(css).toMatch(/\.dot\[data-state='done'\][^{]*\{[^}]*--dsw-alias-state-success-primary/su)
  })

  it('uses the neutral state token for idle', () => {
    expect(css).toMatch(/\.dot\[data-state='idle'\][^{]*\{[^}]*--dsw-alias-state-idle-primary/su)
  })

  it('keeps ongoing on the rotating spinner rather than a solid-dot rule', () => {
    expect(css).not.toContain(".dot[data-state='ongoing']")
    expect(css).toContain('.spinnerTrack')
    expect(css).toContain('.spinnerArc')
    expect(css).toContain('@keyframes dsh-state-dot-spin')
    expect(css).toContain('@keyframes dsh-state-dot-dash')
    expect(css).toMatch(/\.spinnerMotion[^{]*\{[^}]*animation: dsh-state-dot-spin 1\.5s linear infinite/su)
    expect(css).not.toMatch(/\.spinner\s*\{[^}]*animation:/su)
    expect(css).toContain('stroke-dasharray: 12 150')
    expect(css).toContain('stroke-dasharray: 24 150')
    expect(css).toContain('stroke-dashoffset: -6')
  })

  it('stops both animations and retains an intermediate arc for reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.spinnerMotion,')
    expect(reduced).toContain('.spinnerArc')
    expect(reduced).toContain('animation: none')
    expect(reduced).toContain('stroke-dasharray: 18 150')
    expect(reduced).toContain('stroke-dashoffset: -3')
  })
})
