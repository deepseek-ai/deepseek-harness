/**
 * The content row's rules for a workspace navigator that fills it, as CSS text. jsdom has no
 * `:has()` cascade, so this reads the declarations that keep the covered body out of keyboard reach.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/TextPreview.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** @param selector - exact selector list of one rule. @returns the rule's declarations. */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

const NAVIGATOR = "[data-slot-factory='sidebar.files.navigator']"

describe('preview content row under a filling navigator', () => {
  it('hides the row\'s other children while the navigator reports the filled layout', () => {
    expect(declarationsOf('.content > *')).toContain('visibility: var(--navigator-covered, inherit)')
    expect(declarationsOf(`.content:has(> ${NAVIGATOR} > [data-files-navigator-mode='fill'])`))
      .toContain('--navigator-covered: hidden')
  })

  it('keeps the navigator itself visible', () => {
    expect(declarationsOf(`.content,\n.content > ${NAVIGATOR}`)).toContain('--navigator-covered: initial')
  })

  it('treats every navigator layout as filling below 768px', () => {
    const narrow = /@media \(width < 768px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(narrow).toContain(`.content:has(> ${NAVIGATOR} > [data-files-navigator-mode])`)
    expect(narrow).toContain('--navigator-covered: hidden')
  })
})
