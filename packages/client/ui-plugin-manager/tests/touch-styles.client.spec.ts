/**
 * Plugin page touch rules, asserted against the CSS text on disk.
 *
 * jsdom resolves neither `pointer` nor `hover` media features, so these gates read
 * the sheet instead: a `:hover` rule outside `@media (hover: hover)` latches onto a
 * tap and strands the control in its pointer-only state, and a text field under
 * 16px makes iOS Safari zoom the visual viewport when it takes focus.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/PluginManagerPage.module.css', import.meta.url)), 'utf8')
/** Comment bodies blanked, so prose about `:hover` is not read as a rule. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, text => ' '.repeat(text.length))

/** The line holding `index`, for failure messages. */
function lineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1
  const end = source.indexOf('\n', index)
  return source.slice(start, end === -1 ? undefined : end).trim()
}

/** Every state selector with the media query it sits in, read from the sheet's own blocks. */
function statesIn(source: string, pattern: RegExp): { line: string; hoverMedia: boolean }[] {
  const stack: (string | null)[] = []
  const found: { line: string; hoverMedia: boolean }[] = []
  for (const token of source.matchAll(/@media[^{]*\{|:hover|:focus-visible|\{|\}/g)) {
    const text = token[0]
    if (text === '}') {
      stack.pop()
      continue
    }
    if (text === '{') {
      stack.push(null)
      continue
    }
    if (text.startsWith('@media')) {
      // The matched text includes the block's opening brace, which the frame stands for.
      stack.push(text.slice(0, -1))
      continue
    }
    if (!pattern.test(text)) continue
    const index = token.index ?? 0
    found.push({
      line: lineAt(source, index),
      hoverMedia: stack.some(frame => frame !== null && /hover:\s*hover/.test(frame)),
    })
  }
  return found
}

/** The declarations of one rule, by its literal selector. */
function ruleBody(selector: string): string {
  const start = rules.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`PluginManagerPage.module.css has no \`${selector}\` rule`)
  const open = rules.indexOf('{', start)
  return rules.slice(open + 1, rules.indexOf('}', open))
}

describe('plugin page touch rules', () => {
  it('uses the compact page inset below 768px', () => {
    const narrow = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(rules)?.[1]
    expect(narrow).toContain('--plugin-page-inset: 20px')
  })

  it('fences every hover affordance behind a hover-capable pointer', () => {
    // Unguarded, the browser keeps `:hover` on the tapped element until the next tap
    // elsewhere: a card or menu row stays painted as if the pointer were still on it.
    // Each affordance must still exist, so an emptied sheet cannot satisfy the gate.
    const unguarded = statesIn(rules, /^:hover$/).filter(state => !state.hoverMedia)
    expect(unguarded.map(state => state.line)).toEqual([])
    for (const selector of [
      '.groupMore:hover', '.cardLink:hover', '.iconButton:hover', '.deleteButton:hover', '.guideToggle:hover',
      '.registryToggle:hover', '.registryOption:hover', '.wizardClose:hover', '.crumb:hover', '.rowOpen:hover',
    ]) {
      expect(rules).toContain(selector)
    }
  })

  it('keeps focus rings outside the hover fence', () => {
    // A tablet with a keyboard reports no hover; fencing `:focus-visible` with the
    // hover rules would leave keyboard use without a visible focus ring.
    const fenced = statesIn(rules, /^:focus-visible$/).filter(state => state.hoverMedia)
    expect(fenced.map(state => state.line)).toEqual([])
  })

  it('gives touch clients a press state where the hover state is fenced off', () => {
    // Touch-down feedback is the only cue left once hover is fenced: without it a
    // card reads as inert until its detail page appears.
    expect(ruleBody('.cardLink:active')).toContain('background: var(--dsw-alias-interactive-bg-active)')
    expect(ruleBody('.iconButton:active:not(:disabled)')).toContain('background: var(--dsw-alias-interactive-bg-active)')
    expect(ruleBody('.deleteButton:active:not(:disabled)'))
      .toContain('background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover))')
  })

  it('keeps focused text fields at 16px under a coarse pointer', () => {
    // iOS Safari zooms the visual viewport for a focused field under 16px and leaves
    // the page pannable afterwards; the install dialog, the registry address, and the
    // component filter are this page's three text fields.
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? ''
    const rule = /([^{}]+)\{([^{}]*)\}/.exec(coarse)
    expect(rule).not.toBeNull()
    for (const selector of [".installField input[type='text']", '.registryCustomField', '.partsFilter input']) {
      expect(rule?.[1]).toContain(selector)
    }
    expect(rule?.[2]).toContain('font-size: 16px')
  })
})
