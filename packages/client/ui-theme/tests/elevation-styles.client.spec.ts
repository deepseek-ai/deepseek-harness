/**
 * Elevation stylesheet contract, asserted against the CSS text on disk:
 * gradient-shadow-text.css composes the elevation tokens from a rebindable
 * 0.5px hairline stroke plus soft layers, and no package rule pairs an
 * lv/elevation box-shadow with a neutral-border-token border — elevated
 * surfaces draw their neutral stroke inside the elevation shadow (border: 0),
 * never as a layout-consuming border beside it. State-colored borders (for
 * example the warn approval panels) stay real borders and are out of scope.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules } from './stylesheet-scan.ts'

/** Stroke-color indirection components may rebind per surface or state. */
const STROKE_COLOR = '--dsw-elevation-stroke-color'
/** Shadow-token references that mark a rule as an elevated surface. */
const ELEVATED_SHADOW = /--dsw-(?:shadow-lv|elevation-)/
/** Neutral border tokens; the state palette (--dsw-alias-state-*) stays allowed. */
const NEUTRAL_BORDER = /--dsw-alias-border-/

const sheetCss = readFileSync(
  fileURLToPath(new URL('../src/styles/gradient-shadow-text.css', import.meta.url)), 'utf8')

describe('elevation tokens', () => {
  const rules = parseRules(sheetCss)
  const bodyOnly = new Map(rules
    .filter(rule => rule.selectors.length === 1 && rule.selectors[0] === 'body')
    .flatMap(rule => rule.declarations))
  const perElement = new Map(rules
    .filter(rule => rule.selectors.includes('body *'))
    .flatMap(rule => rule.declarations))

  it('defaults the stroke color on body alone, so a surface rebind inherits', () => {
    // Declared per element, `body *` would beat inheritance on every
    // descendant and a surface's rebind could not reach the box that carries
    // the shadow; declared on body alone, the rebind inherits down.
    expect(bodyOnly.get(STROKE_COLOR)).toBe('var(--dsw-alias-border-l4)')
    expect(perElement.has(STROKE_COLOR)).toBe(false)
  })

  it('declares the derived values per element, so a stroke rebind takes effect', () => {
    // A custom property computes with var() already substituted, and
    // descendants inherit that computed value: derived tokens declared only on
    // body would bake in body's stroke color, making every
    // --dsw-elevation-stroke-color rebind a no-op. Per-element declarations
    // re-substitute against the color each element sees (the same contract
    // scrollbar.css states for --dsh-scrollbar-thumb).
    expect(perElement.get('--dsw-elevation-stroke')).toBe(`0 0 0 0.5px var(${STROKE_COLOR})`)
    for (const name of ['--dsw-elevation-panel', '--dsw-elevation-prominent', '--dsw-elevation-soft']) {
      expect(perElement.get(name), name).toMatch(/^var\(--dsw-elevation-stroke\), 0 /)
      expect(bodyOnly.has(name), name).toBe(false)
    }
  })
})

/**
 * Rules pairing an lv/elevation box-shadow with a neutral-border-token border.
 * @param css - stylesheet text.
 * @returns the offending selectors, in source order.
 */
function neutralBordersBesideElevation(css: string): string[] {
  return parseRules(css)
    .filter(rule => rule.declarations
      .some(([property, value]) => property === 'box-shadow' && ELEVATED_SHADOW.test(value)))
    .filter(rule => rule.declarations.some(([property, value]) =>
      property.startsWith('border') && !property.startsWith('border-radius') && NEUTRAL_BORDER.test(value)))
    .map(rule => rule.selectors.join(', '))
}

describe('elevated surfaces carry no neutral border', () => {
  it('rejects a rule that pairs the shadow with a neutral border', () => {
    expect(neutralBordersBesideElevation(
      '.a { box-shadow: var(--dsw-elevation-panel); border: 0.5px solid var(--dsw-alias-border-l2); }',
    )).toEqual(['.a'])
    expect(neutralBordersBesideElevation(
      '.a { box-shadow: var(--dsw-elevation-panel); border: 0; }',
    )).toEqual([])
  })

  it('never pairs an lv/elevation shadow with a neutral border token under packages/', () => {
    // A 1px border beside the elevation stroke double-draws the outline and
    // shifts layout by the border width; the hairline belongs to the shadow.
    const paired = packageStylesheets().flatMap(file =>
      neutralBordersBesideElevation(readFileSync(file, 'utf8'))
        .map(selectors => `${file} ${selectors}`))
    expect(paired).toEqual([])
  })
})

/** Border properties that carry a width in their shorthand. */
const BORDER_EDGE = /^border(?:-top|-bottom|-left|-right)?$/

/**
 * Solid neutral-token borders wider than the 0.5px hairline. The width test is
 * lexical and order-sensitive: `border: solid 0.5px …` would be reported (a
 * loud false positive to normalize), while split `border-width`/`border-color`
 * declarations fall outside BORDER_EDGE and are not seen; no sheet under test
 * writes either form.
 * @param css - stylesheet text.
 * @param exempt - `<selector> <property>` pairs allowed to keep their width.
 * @returns the offending `<selectors> <property>: <value>` lines, in source order.
 */
function wideNeutralBorders(css: string, exempt: Set<string> = new Set()): string[] {
  const wide: string[] = []
  for (const rule of parseRules(css)) {
    for (const [property, value] of rule.declarations) {
      if (!BORDER_EDGE.test(property)) continue
      if (!value.includes('solid') || !NEUTRAL_BORDER.test(value)) continue
      if (value.startsWith('0.5px ')) continue
      if (rule.selectors.some(selector => exempt.has(selector))) continue
      wide.push(`${rule.selectors.join(', ')} ${property}: ${value}`)
    }
  }
  return wide
}

/**
 * Filled divider lines (a border-token background on a 1px-tall or 1px-wide
 * box) that keep the pre-hairline weight.
 * @param css - stylesheet text.
 * @returns the offending `<selectors> <property>: <value>` lines, in source order.
 */
function wideFilledDividers(css: string): string[] {
  const wide: string[] = []
  for (const rule of parseRules(css)) {
    const paintsLine = rule.declarations.some(([property, value]) =>
      (property === 'background' || property === 'background-color') && NEUTRAL_BORDER.test(value))
    if (!paintsLine) continue
    for (const [property, value] of rule.declarations) {
      if ((property === 'height' || property === 'width') && value === '1px') {
        wide.push(`${rule.selectors.join(', ')} ${property}: ${value}`)
      }
    }
  }
  return wide
}

describe('neutral solid borders are hairlines', () => {
  /**
   * Spinner ring tracks, keyed `<basename> <selector>`: the border is the
   * drawn graphic (a rotating ring), not an outline, so it keeps its width.
   */
  const RING_TRACKS = new Set([
    'boot-page.module.css .spinner',
    'TrajectoryTable.module.css .historyLoadingSpinner',
  ])

  it('rejects a wide neutral border and a wide filled divider', () => {
    expect(wideNeutralBorders('.a { border: 1px solid var(--dsw-alias-border-l2); }'))
      .toEqual(['.a border: 1px solid var(--dsw-alias-border-l2)'])
    expect(wideNeutralBorders('.a { border: 0.5px solid var(--dsw-alias-border-l2); }')).toEqual([])
    expect(wideFilledDividers('.a { background: var(--dsw-alias-border-l2); height: 1px; }'))
      .toEqual(['.a height: 1px'])
    expect(wideFilledDividers('.a { background: var(--dsw-alias-border-l2); height: 0.5px; }')).toEqual([])
  })

  it('draws every solid neutral-token border at 0.5px under packages/', () => {
    // Buttons, inputs, cards, and separators share the hairline weight;
    // dashed affordances and state-colored borders are out of scope.
    const wide = packageStylesheets().flatMap((file) => {
      const base = basename(file)
      const exempt = new Set([...RING_TRACKS]
        .filter(track => track.startsWith(`${base} `))
        .map(track => track.slice(base.length + 1)))
      return wideNeutralBorders(readFileSync(file, 'utf8'), exempt)
        .map(line => `${file} ${line}`)
    })
    expect(wide).toEqual([])
  })

  it('draws every filled divider line at 0.5px under packages/', () => {
    // A separator drawn as a filled box — 1px tall or wide with a border-token
    // background (menu separators, the conversation header seam, markdown hr,
    // vertical rails) — is the same hairline as a border. Visually-hidden 1px
    // clip boxes carry no border-token background and stay exempt.
    const wide = packageStylesheets().flatMap(file =>
      wideFilledDividers(readFileSync(file, 'utf8')).map(line => `${file} ${line}`))
    expect(wide).toEqual([])
  })
})
