/**
 * The chat flow's font-size-axis adoption as CSS text. jsdom has no layout,
 * so these read the declarations that make think text, compaction rows, the
 * message clock, and the icon-action buttons follow the Settings font-size
 * preference through --dsh-content-font-size / --dsh-content-font-delta.
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

describe('chat flow font-size axis', () => {
  it('think text reads the secondary tier (one step under the body size)', () => {
    const css = read('ReasoningRow.module.css')
    for (const selector of ['.summary', '.thinkBody']) {
      expect(declarationsFrom(css, selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      ]))
    }
  })

  it('command and context summaries read the secondary tier on the shared row line', () => {
    expect(declarationsFrom(read('GenericCommandCard.module.css'), '.summary')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
      'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]))
    const context = read('ContextInjectionRow.module.css')
    for (const selector of ['.source', '.summary']) {
      expect(declarationsFrom(context, selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
  })

  it('the message clock and action glyphs scale with the text they serve', () => {
    const actions = read('MessageIconActions.module.css')
    // Both clocks read the secondary tier: the assistant tail's meta line
    // (the whole-line usage trigger) and the user row's clock stay one step
    // under the body size so the two rows match.
    expect(declarationsFrom(actions, '.timeStart')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
    ]))
    expect(declarationsFrom(actions, '.timeEnd')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
    ]))
    expect(declarationsFrom(actions, '.action svg')).toEqual(expect.arrayContaining([
      'width: calc(15px + var(--dsh-content-font-delta, 0px))',
      'height: calc(15px + var(--dsh-content-font-delta, 0px))',
    ]))
  })

  it('compaction rows follow the axis like the disclosure rows they mirror', () => {
    const css = read('MessageItem.module.css')
    for (const selector of ['.compactionTitle', '.compactionSummary', '.compactionBody']) {
      expect(declarationsFrom(css, selector)).toEqual(expect.arrayContaining([
        'font-size: var(--dsh-content-font-size-secondary, 13px)',
        'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
      ]))
    }
    expect(declarationsFrom(css, '.compactionLeading svg')).toEqual(expect.arrayContaining([
      'width: calc(14px + var(--dsh-content-font-delta, 0px))',
      'height: calc(14px + var(--dsh-content-font-delta, 0px))',
    ]))
  })

  it('expanded bodies indent by 22px + delta so content stays under the shifted title start', () => {
    // The DisclosureRow title starts at leading (16 + delta) + gap 6; a fixed
    // 22px indent would misalign at every non-default size.
    const indent = 'calc(22px + var(--dsh-content-font-delta, 0px))'
    expect(declarationsFrom(read('ReasoningRow.module.css'), '.thinkBody'))
      .toEqual(expect.arrayContaining([`padding: 4px 0 4px ${indent}`]))
    expect(declarationsFrom(read('MessageItem.module.css'), '.compactionBody'))
      .toEqual(expect.arrayContaining([`padding: 4px 0 4px ${indent}`]))
    expect(declarationsFrom(read('ContextInjectionRow.module.css'), '.body'))
      .toEqual(expect.arrayContaining([`margin: 4px 0 0 ${indent}`]))
  })

  it('the usage-details trigger reads the secondary tier like its clock label', () => {
    const css = read('TurnUsagePanel.module.css')
    expect(declarationsFrom(css, '.trigger')).toEqual(expect.arrayContaining([
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
      'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]))
  })

  it('the usage pill sizes its glyph and hit height like the sibling action buttons', () => {
    // The pill sits in the icon row right of the branch action; its data glyph
    // and 28px hit height follow the same delta rule as `.action` so the row
    // stays one height at every font size.
    const css = read('TurnUsagePanel.module.css')
    expect(declarationsFrom(css, '.trigger')).toEqual(expect.arrayContaining([
      'height: calc(28px + var(--dsh-content-font-delta, 0px))',
      'white-space: nowrap',
      'min-width: 0',
    ]))
    expect(declarationsFrom(css, '.trigger svg')).toEqual(expect.arrayContaining([
      'width: calc(15px + var(--dsh-content-font-delta, 0px))',
      'height: calc(15px + var(--dsh-content-font-delta, 0px))',
    ]))
    // A narrow column trims the pill label to an ellipsis instead of letting
    // it overflow or widen the chat column.
    expect(declarationsFrom(css, '.label')).toEqual(expect.arrayContaining([
      'min-width: 0',
      'overflow: hidden',
      'text-overflow: ellipsis',
    ]))
  })

  it('narrow viewports collapse the stat pills to the action-button circle', () => {
    // Below 480px the label hides and the pill takes the sibling `.action`
    // geometry (28px width, 6px padding, centered glyph); the -6px
    // label-padding rebate between adjacent pills resets so the icon pair
    // keeps the row's plain 8px rhythm instead of overlapping.
    const css = read('TurnUsagePanel.module.css')
    const narrow = /@media \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(narrow).toMatch(/\.trigger \{[^}]*justify-content: center/)
    expect(narrow).toMatch(/\.trigger \{[^}]*width: calc\(28px \+ var\(--dsh-content-font-delta, 0px\)\)/)
    expect(narrow).toMatch(/\.trigger \{[^}]*padding: 6px/)
    expect(narrow).toMatch(/\.trigger \.label \{[^}]*display: none/)
    expect(narrow).toMatch(/\.root \+ \.root \{[^}]*margin-left: 0/)
  })

  it('non-latest turn tails hide the whole actions row until hover or focus', () => {
    // TurnTailNodeView tags its root data-actions-reveal='hover' for every
    // turn but the latest; the gate lives under @media (hover: hover) so
    // no-hover devices keep the row visible. 'always' has no rule at all —
    // absence, not an override, keeps the latest turn's row shown.
    const css = read('MessageIconActions.module.css')
    expect(css).toContain("[data-actions-reveal='hover'] .actions,")
    expect(css).toMatch(/\) \.actions \{\s*opacity: 0/)
    expect(css).toContain("[data-actions-reveal='hover']:hover .actions,")
    expect(css).toContain("[data-actions-reveal='hover']:focus-within .actions,")
    expect(css).toMatch(/\):focus-within \.actions \{\s*opacity: 1/)
    expect(css).not.toContain("[data-actions-reveal='always']")
  })

  it('uses flow sibling selectors to reveal only the latest user-authored row', () => {
    const css = read('MessageIconActions.module.css')
    const userKinds = ":is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])"
    expect(css).toContain(`${userKinds}:has(\n    ~ ${userKinds}\n  ) .actions`)
    expect(css).toContain('):hover .actions')
    expect(css).toContain('):focus-within .actions')
  })

  it('the interrupted-turn tag stays fixed like the dense token variants', () => {
    // 11px would fall to an illegible 9px at the 12px floor; the tag is
    // exempt from the axis the same way small/code tokens are.
    expect(declarationsFrom(read('AssistantMarkdown.module.css'), '.stopped')).toEqual(expect.arrayContaining([
      'font-size: 11px',
      'line-height: 18px',
    ]))
  })
})
