/**
 * Corner-shape stylesheet contract, asserted against the CSS text on disk:
 * corner-shape.css smooths every rounded corner to the superellipse token
 * strictly inside a `@supports` guard, and every effectively full-round radius
 * in any package stylesheet pairs `corner-shape: round` in the same rule,
 * because a superellipse deforms a circle into a squircle (a spinner would
 * visibly wobble) and squares off capsule ends.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { atRuleBlock, packageStylesheets, parseRules } from './stylesheet-scan.ts'

/** The support guard prelude, spelled exactly as the sheet must spell it. */
const GUARD = '@supports (corner-shape: superellipse(1.5))'
/** The smoothing token corner-shape.css owns. */
const TOKEN = '--dsw-corner-shape'

const sheetPath = fileURLToPath(new URL('../src/styles/corner-shape.css', import.meta.url))
const sheetCss = readFileSync(sheetPath, 'utf8')

/**
 * Whether a border-radius value makes the element full-round: an uncapped
 * fraction of the box (50%/100%) or a pill radius far above any box size.
 * Component-local radius indirections stay below the pill threshold, so the
 * check is lexical over literal components.
 * @param value - a border-radius declaration value.
 * @returns true when some component is full-round.
 */
function isFullRound(value: string): boolean {
  return value.split(/\s+/).some(part =>
    part === '50%' || part === '100%' || (part.endsWith('px') && Number.parseFloat(part) >= 99))
}

describe('corner-shape.css smoothing', () => {
  const withoutComments = sheetCss.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const guard = atRuleBlock(withoutComments, GUARD)

  it('declares the token and its application only inside the support guard', () => {
    // Outside the guard the declarations would be dropped as invalid anyway,
    // but only on engines without corner-shape; keeping everything inside the
    // guard states that unsupporting engines keep plain circular corners.
    expect(guard, GUARD).toBeDefined()
    const before = withoutComments.slice(0, withoutComments.indexOf(GUARD))
    const after = withoutComments.slice(guard!.end + 1)
    expect(before.trim(), `content before ${GUARD}`).toBe('')
    expect(after.trim(), `content after ${GUARD}`).toBe('')
  })

  it('defines the superellipse token on :root and applies it universally', () => {
    // corner-shape does not inherit, so only the universal selector (with the
    // generated ::before/::after) reaches every rounded surface.
    const rules = parseRules(withoutComments.slice(guard!.start + 1, guard!.end))
    const root = rules.find(rule => rule.selectors.includes(':root'))
    expect(root?.declarations).toContainEqual([TOKEN, 'superellipse(1.5)'])
    const universal = rules.find(rule => rule.selectors.includes('*'))
    expect(universal?.selectors).toEqual(['*', '*::before', '*::after'])
    expect(universal?.declarations).toContainEqual(['corner-shape', `var(${TOKEN})`])
  })
})

/**
 * Full-round rules missing the `corner-shape: round` pairing.
 * @param css - stylesheet text.
 * @returns the offending selectors, in source order.
 */
function unpairedFullRound(css: string): string[] {
  return parseRules(css)
    .filter(rule => rule.declarations
      .some(([property, value]) => property === 'border-radius' && isFullRound(value)))
    .filter(rule => !rule.declarations
      .some(([property, value]) => property === 'corner-shape' && value === 'round'))
    .map(rule => rule.selectors.join(', '))
}

describe('full-round radii keep circular corners', () => {
  it('rejects a full-round radius without the pairing', () => {
    expect(unpairedFullRound('.a { border-radius: 50%; }')).toEqual(['.a'])
    expect(unpairedFullRound('.a { border-radius: 999px; }')).toEqual(['.a'])
    expect(unpairedFullRound('.a { border-radius: 50%; corner-shape: round; }')).toEqual([])
  })

  it('pairs corner-shape: round with every full-round border-radius under packages/', () => {
    // The universal superellipse reaches every element, so each circle and
    // pill states its own arc back; a new one without the pairing regresses
    // silently on supporting engines only, which no jsdom test renders.
    const unpaired = packageStylesheets().flatMap(file =>
      unpairedFullRound(readFileSync(file, 'utf8')).map(selectors => `${file} ${selectors}`))
    expect(unpaired).toEqual([])
  })
})
