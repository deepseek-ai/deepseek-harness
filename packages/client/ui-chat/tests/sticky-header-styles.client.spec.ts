/**
 * The two pinned collapsible headers as CSS text. jsdom has no layout, so the
 * rendering specs pin which DOM anchors the selectors key on but cannot show
 * whether the pinning declarations resolve; these read the declarations the
 * pinning and the stacking rank depend on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

function declarationsFrom(source: string, selector: string): string[] {
  const declarationText = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('pinned collapsible headers', () => {
  it('pins an open Think header to the scrollport top and masks the prose under it', () => {
    expect(
      declarationsFrom(read('ReasoningRow.module.css'), '.root[data-expanded] [data-open] [data-disclosure-row]'),
    ).toEqual(expect.arrayContaining([
      'position: sticky',
      'top: 0',
      'z-index: 1',
      'background: var(--dsw-alias-bg-base)',
    ]))
  })

  it('ranks the pinned compaction header above the code-block banner', () => {
    expect(
      declarationsFrom(read('MessageItem.module.css'), '.compactionRow:has(.compactionBody) .compactionButton'),
    ).toEqual(expect.arrayContaining([
      'position: sticky',
      'top: 0',
      // CodeBlock.module.css pins its banner at 6; a lower rank here would let
      // a summary's fenced code block cover the toggle.
      'z-index: 7',
      // The opaque fill masks the prose only if the box has no rounded corners
      // for it to show through.
      'border-radius: 0',
      'background: var(--dsw-alias-bg-base)',
    ]))
  })

  it('holds a summary code banner below the pinned header band, on the toggle\'s own measurement', () => {
    const css = read('MessageItem.module.css')
    // One home for the band height: the toggle's height and the offset that
    // keeps a code banner clear of it must never drift apart, and sticky gives
    // no error when they do.
    expect(declarationsFrom(css, '.compactionRow')).toEqual(expect.arrayContaining([
      '--dsh-compaction-header-height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]))
    expect(declarationsFrom(css, '.compactionButton')).toEqual(expect.arrayContaining([
      'height: var(--dsh-compaction-header-height)',
    ]))
    expect(declarationsFrom(css, '.compactionBody :has(> [data-code-block-banner])')).toEqual(expect.arrayContaining([
      'top: var(--dsh-compaction-header-height)',
    ]))
  })

  it('keeps the pinned compaction header opaque under hover', () => {
    expect(
      declarationsFrom(read('MessageItem.module.css'), '.compactionRow:has(.compactionBody) .compactionButton:hover'),
    ).toEqual(expect.arrayContaining(['background: var(--dsw-alias-interactive-bg-hover-solid)']))
  })
})
