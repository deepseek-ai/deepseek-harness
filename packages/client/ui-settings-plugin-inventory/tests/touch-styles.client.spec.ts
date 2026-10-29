/**
 * Built-in plugin inventory touch rules, asserted against the CSS text on disk.
 *
 * jsdom resolves neither `pointer` nor `hover` media features, so these gates read
 * the sheet instead: a `:hover` rule outside `@media (hover: hover)` latches onto a
 * tap and strands the card in its pointer-only state, and the 13px search field
 * makes iOS Safari zoom the visual viewport when it takes focus.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/PluginInventorySettingsTab.module.css', import.meta.url)), 'utf8')
/** Comment bodies blanked, so prose about `:hover` is not read as a rule. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, text => ' '.repeat(text.length))

/** Every `:hover` selector sitting in the media query that encloses it. */
function hovers(source: string): { line: string; hoverMedia: boolean }[] {
  const stack: (string | null)[] = []
  const found: { line: string; hoverMedia: boolean }[] = []
  for (const token of source.matchAll(/@media[^{]*\{|@container[^{]*\{|:hover|\{|\}/g)) {
    const text = token[0]
    if (text === '}') {
      stack.pop()
      continue
    }
    if (text === '{') {
      stack.push(null)
      continue
    }
    if (text.startsWith('@')) {
      // The matched text includes the block's opening brace, which the frame stands for.
      stack.push(text.slice(0, -1))
      continue
    }
    const start = source.lastIndexOf('\n', token.index ?? 0) + 1
    const end = source.indexOf('\n', token.index ?? 0)
    found.push({
      line: source.slice(start, end === -1 ? undefined : end).trim(),
      hoverMedia: stack.some(frame => frame !== null && /hover:\s*hover/.test(frame)),
    })
  }
  return found
}

/** The declarations inside every `@media (hover: hover)` block, joined. */
function hoverBlock(): string {
  return [...rules.matchAll(/@media \(hover: hover\) \{([\s\S]*?)\n\}/g)].map(match => match[1] ?? '').join('\n')
}

/** The declarations of one rule, by its literal selector. */
function ruleBody(selector: string): string {
  const start = rules.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`PluginInventorySettingsTab.module.css has no \`${selector}\` rule`)
  const open = rules.indexOf('{', start)
  return rules.slice(open + 1, rules.indexOf('}', open))
}

describe('built-in plugin inventory touch rules', () => {
  it('fences every hover affordance behind a hover-capable pointer', () => {
    // The card background and the preset switcher are the tab's only hover states;
    // unguarded, a single tap leaves the card painted as hovered.
    const unguarded = hovers(rules).filter(state => !state.hoverMedia)
    expect(unguarded.map(state => state.line)).toEqual([])
    expect(rules).toContain('.cardContent:hover')
    expect(rules).toContain('.switcher:hover')
  })

  it('keeps the open card painted without a pointer', () => {
    // An expanded card shows the same surface as a hovered one, and it must hold on
    // a touch client: it belongs outside the hover fence, not inside it.
    expect(ruleBody(".card[data-open='true'] > .cardContent"))
      .toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(hoverBlock()).not.toContain('data-open')
  })

  it('gives touch clients a press state where the hover state is fenced off', () => {
    expect(ruleBody('.cardContent:active')).toContain('background: var(--dsw-alias-interactive-bg-active)')
    expect(ruleBody('.switcher:active')).toContain('background: var(--dsw-alias-interactive-bg-active)')
  })

  it('keeps the focused search field at 16px under a coarse pointer', () => {
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? ''
    expect(coarse).toMatch(/\.search input \{[^}]*font-size: 16px/)
  })
})
