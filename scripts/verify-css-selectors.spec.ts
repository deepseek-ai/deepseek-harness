import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkStylesheet, compareBaseline, countFindings, listStylesheets, parseBaseline, type CssSelectorDefect } from './verify-css-selectors.ts'

const root = resolve(import.meta.dirname, '..')

function defects(source: string, file = 'packages/client/x/src/a.module.css'): [number, CssSelectorDefect, string][] {
  return checkStylesheet(file, source).map(finding => [finding.line, finding.defect, finding.selector])
}

describe('verify-css-selectors', () => {
  it.each([
    '.a', '#a', 'div', '[data-x]', '[data-x="y"]', ':root', 'a:link', 'a:any-link', ':focus', ':focus-visible',
    ':is(.a)', ':where(.a .b)', '.a::before', 'input::placeholder', '::-webkit-scrollbar-thumb', '.a :not(.b).c',
    '.x:has(.y)', '.a:not(:has(.b))', '.a:has(.b .c)', ':global(.a) > :global(.b)', '.a :global(.b.c)',
    '.a:hover', '.a:empty', ':is(:where(.a))',
  ])('accepts the bucketed subject %s', (selector) => {
    expect(defects(`${selector} { color: red }`)).toEqual([])
  })

  it.each([
    '.a > *', '.a *', '.card *', '.a > *:first-child', '.a :global(:first-child)', '.list > * + *', ':is(.a, .b)',
    ':where(.a, .b)', '.a :hover', '.a ::selection', '.a :disabled', ':is(.a, .b) *', ':where([data-x] *)', ':is(.a > *)',
    ':global(.a) > :global(*)', 'li > .a ~ *', ':is(.x:not(.y) > span, .z)', '.c > :where(.x:not(.y) *)',
  ])('accepts the scoped unkeyed subject %s', (selector) => {
    expect(defects(`${selector} { color: red }`)).toEqual([])
  })

  it.each([
    ':empty:not([class])', '.a > :not(.b)', '.a > *:not(.b)', '.a :empty', '.a > :has(.b)', ':is(.a) > :is(:empty, .b)',
    ':global(.a) > :not(:global(.b))', '.a > .b + :not([hidden])', '.a > :nth-child(2 of :not(.b))',
  ])('rejects the unkeyed subject using :not(), :empty or :has() in %s', (selector) => {
    expect(defects(`${selector} { color: red }`).map(([, defect]) => defect)).toEqual(['unkeyed-costly-subject'])
  })

  it.each([
    '*', ':hover', '::before', '::-webkit-scrollbar', 'body *', 'html body > *', ':hover::before', 'div > *', '*:not(.a) *',
    ':is(.a, *) > *',
  ])('rejects the unscoped universal selector %s', (selector) => {
    expect(defects(`${selector} { color: red }`).map(([, defect]) => defect)).toEqual(['global-universal'])
  })

  it('exempts framework stylesheets from subject rules but not from the :has() rule', () => {
    const file = 'packages/client/web/src/base.css'
    expect(defects('* { box-sizing: border-box }\nbody > :not(#root) { color: red }\n', file)).toEqual([])
    expect(defects('.a:has(.b) .c { color: red }', file).map(([, defect]) => defect)).toEqual(['has-outside-subject'])
    expect(defects('* { box-sizing: border-box }', 'packages/client/ui-theme/src/styles/x.css')).toEqual([])
    expect(defects('* { box-sizing: border-box }', 'packages/client/ui-theme/src/client/x.module.css').map(([, defect]) => defect))
      .toEqual(['global-universal'])
  })

  it.each([
    '.a:has(.b) .c', '.a:has(.b) > .c', '.a:has(.b) + .c', ':is(.a:has(.b)) .c', '.c:not(.a:has(.b) .d)',
    ':global(.a:has(.b)) .c', '.c:is(:where(.a:has(.b) .d))',
  ])('rejects :has() outside the subject in %s', (selector) => {
    expect(defects(`${selector} { color: red }`).map(([, defect]) => defect)).toEqual(['has-outside-subject'])
  })

  it('reports both defects of one selector and each selector of a list', () => {
    expect(defects('.ok, .a:has(.b) > :not(.c), * { color: red }')).toEqual([
      [1, 'unkeyed-costly-subject', '.a:has(.b) > :not(.c)'],
      [1, 'has-outside-subject', '.a:has(.b) > :not(.c)'],
      [1, 'global-universal', '*'],
    ])
  })

  it('reads rules inside at-rules and reports one-based lines', () => {
    expect(defects('.a { color: red }\n@media (width < 768px) {\n  .b > :not(.c) { color: red }\n}\n@supports (display: grid) {\n  :hover { color: red }\n}\n'))
      .toEqual([[3, 'unkeyed-costly-subject', '.b > :not(.c)'], [6, 'global-universal', ':hover']])
  })

  it('rejects nested rules instead of guessing what & resolves to', () => {
    expect(defects('.a {\n  color: red;\n  & > * { color: blue }\n}\n').map(([, defect]) => defect)).toEqual(['nesting'])
  })

  it('accepts a rejected rule whose reason comment ends on the line directly above it', () => {
    expect(defects('/* css-selector-gate: the scrollbar pseudo-element has no keyed form */\n::-webkit-scrollbar { width: 8px }\n')).toEqual([])
    expect(defects('/*\n  css-selector-gate: reason spanning\n  two lines\n*/\n* { color: red }\n')).toEqual([])
  })

  it('rejects an exception comment that is empty, detached, or above an accepted rule', () => {
    expect(defects('/* css-selector-gate: */\n* { color: red }\n')).toEqual([
      [1, 'stale-exception', 'css-selector-gate:'],
      [2, 'global-universal', '*'],
    ])
    expect(defects('/* css-selector-gate: reason */\n\n* { color: red }\n')).toEqual([
      [1, 'stale-exception', 'css-selector-gate: reason'],
      [3, 'global-universal', '*'],
    ])
    expect(defects('/* css-selector-gate: reason */\n.a { color: red }\n')).toEqual([[1, 'stale-exception', 'css-selector-gate: reason']])
  })

  it('parses plain stylesheets without CSS Modules syntax and names a file it cannot parse', () => {
    expect(defects('.a > :not(.b) { color: red }', 'packages/client/x/src/plain.css').map(([, defect]) => defect)).toEqual(['unkeyed-costly-subject'])
    expect(() => checkStylesheet('packages/client/x/src/bad.css', '.a { color: red')).not.toThrow()
    expect(() => checkStylesheet('packages/client/x/src/bad.module.css', ':global(')).toThrow(/bad\.module\.css/u)
  })

  it('scans repository stylesheets outside vendor', () => {
    const files = listStylesheets(root)
    expect(files).toContain('packages/client/ui-chat/src/client/chat/ChatView.module.css')
    expect(files.every(file => file.endsWith('.css') && !file.startsWith('vendor/'))).toBe(true)
  })

  it('serializes attribute operators, values and case flags so recorded selectors stay exact', () => {
    expect(defects('[a="b c"][d^=e i] > :empty { color: red }').map(([, , selector]) => selector)).toEqual(['[a="b c"][d^="e" i] > :empty'])
  })

  describe('baseline', () => {
    const file = 'packages/client/x/src/a.module.css'
    const findings = checkStylesheet(file, '.a > :empty { color: red }\n.b > :empty { color: red }\n.c:has(.d) .e { color: red }\n')

    it('counts findings by file, defect and selector', () => {
      expect(countFindings(findings)).toEqual({ [file]: {
        'has-outside-subject': { '.c:has(.d) .e': 1 },
        'unkeyed-costly-subject': { '.a > :empty': 1, '.b > :empty': 1 },
      } })
    })

    it('accepts recorded occurrences and rejects one beyond its count or in another file', () => {
      const baseline = countFindings(findings)
      expect(compareBaseline(findings, baseline)).toEqual({ added: [], stale: [] })
      const extra = checkStylesheet(file, '.a > :empty { color: red }\n.a > :empty { color: blue }\n.b > :empty { color: red }\n.c:has(.d) .e { color: red }\n')
      expect(compareBaseline(extra, baseline).added.map(finding => [finding.line, finding.selector])).toEqual([[2, '.a > :empty']])
      const moved = findings.map(finding => ({ ...finding, file: 'packages/client/x/src/b.module.css' }))
      expect(compareBaseline(moved, baseline).added).toHaveLength(3)
    })

    it('reports a recorded occurrence that no longer exists', () => {
      const fixed = checkStylesheet(file, '.a > .f { color: red }\n.b > :empty { color: red }\n.c:has(.d) .e { color: red }\n')
      expect(compareBaseline(fixed, countFindings(findings))).toEqual({ added: [], stale: [[file, 'unkeyed-costly-subject', '.a > :empty', 1]] })
    })

    it('never records nesting or stale exception comments', () => {
      const unrecordable = checkStylesheet(file, '/* css-selector-gate: reason */\n.a { color: red }\n.b { & .c { color: red } }\n')
      expect(countFindings(unrecordable)).toEqual({})
      expect(compareBaseline(unrecordable, {}).added.map(finding => finding.defect)).toEqual(['stale-exception', 'nesting'])
    })

    it.each([
      [[], /file-to-defects/u],
      [{ 'a.ts': { 'global-universal': { '*': 1 } } }, /invalid baseline file/u],
      [{ 'vendor/a.css': { 'global-universal': { '*': 1 } } }, /invalid baseline file/u],
      [{ '../a.css': { 'global-universal': { '*': 1 } } }, /invalid baseline file/u],
      [{ 'a.css': {} }, /invalid baseline file/u],
      [{ 'a.css': { 'nesting': { '*': 1 } } }, /invalid baseline defect/u],
      [{ 'a.css': { 'global-universal': {} } }, /invalid baseline defect/u],
      [{ 'a.css': { 'global-universal': { '*': 0 } } }, /invalid baseline count/u],
      [{ 'a.css': { 'global-universal': { '*': 1.5 } } }, /invalid baseline count/u],
    ])('rejects the malformed baseline %j', (value, message) => {
      expect(() => parseBaseline(value)).toThrow(message)
    })
  })
})
