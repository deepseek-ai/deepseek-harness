/** Shared radius choices cover controls and cards; small drawing details retain their geometry. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules, varReferences } from './stylesheet-scan.ts'

const base = readFileSync(fileURLToPath(new URL('../src/styles/base.css', import.meta.url)), 'utf8')
const tokens = new Set(parseRules(base).flatMap(rule => rule.declarations)
  .filter(([name]) => name.startsWith('--dsw-radius-')).map(([name]) => name))
// Navigation markers and the 10px switch track are drawings, not control containers.
const drawings = new Map([
  ['ui-chat/src/client/chat/TurnNavigator.module.css', '.mark'],
  ['ui-trajectory/src/client/TrajectoryToolbar.module.css', '.controlTrack'],
])

/**
 * Find finite component radii that bypass the theme or reference an absent radius token.
 * @param css - Component stylesheet text.
 * @returns Selector and declaration pairs that need a shared token.
 */
function unscaledRadii(css: string): string[] {
  return parseRules(css).flatMap(rule => rule.declarations
    .filter(([property]) => /^border(?:-[\w-]+)?-radius$/.test(property) || /^--dsl-.*radius$/.test(property))
    .filter(([, value]) => [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)]
      .some(([, number]) => Number(number) > 4 && Number(number) < 99)
      || varReferences(value).some(name => name.startsWith('--dsw-radius-') && !tokens.has(name)))
    .map(([property, value]) => `${rule.selectors.join(', ')}: ${property}: ${value}`))
}

describe('component radius scale', () => {
  it('rejects local radii and misspelled tokens while accepting drawing details and full-round shapes', () => {
    expect(unscaledRadii('.button { border-radius: 14px; }')).toHaveLength(1)
    expect(unscaledRadii('.card { border-top-left-radius: 18px; }')).toHaveLength(1)
    expect(unscaledRadii('.card { --dsl-code-block-border-radius: 12px; }')).toHaveLength(1)
    expect(unscaledRadii('.card { border-radius: var(--dsw-radius-missing); }')).toHaveLength(1)
    expect(unscaledRadii('.card { border-radius: var(--dsw-radius-xl); }')).toEqual([])
    expect(unscaledRadii('.dot { border-radius: 2px; } .circle { border-radius: 50%; } .pill { border-radius: 999px; }')).toEqual([])
  })

  it('keeps client component radii on the shared scale with exact package-owned exceptions', () => {
    const exceptions = JSON.parse(readFileSync(new URL('./expected/radius-exceptions.expected.json', import.meta.url), 'utf8')) as Record<string, string[]>
    const failures = Object.fromEntries(packageStylesheets()
      .filter(file => file.includes('/packages/client/') && file.includes('/src/') && !file.includes('/src/styles/'))
      .map((file): [string, string[]] => {
        const drawing = [...drawings].find(([suffix]) => file.endsWith(suffix))?.[1]
        const radii = unscaledRadii(readFileSync(file, 'utf8'))
          .filter(failure => drawing === undefined || !failure.startsWith(`${drawing}:`))
        return [file.slice(file.indexOf('/packages/client/') + '/packages/client/'.length), radii]
      }).filter(([, radii]) => radii.length > 0))
    expect(failures).toEqual(exceptions)
  })
})
