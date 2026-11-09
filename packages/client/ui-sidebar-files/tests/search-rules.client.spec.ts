/** Exclusion rule editing, default restoration, stored preferences, and hidden entries. */
import { describe, expect, it } from 'vitest'
import {
  addRule, changedSearchPreferences, defaultRules, defaultSearchPreferences, enabledPaths, isDefaultRules, isHiddenEntry,
  normalizeRulePath, readSearchPreferences, removeRule, setRuleEnabled, type ExclusionRule,
} from '../src/client/search-rules.ts'

const DEFAULTS = [
  '.git', '.hg', '.next', '.pnpm-store', '.svn', '.turbo', '.yarn', 'build', 'coverage', 'dist', 'node_modules',
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
]

describe('normalizeRulePath', () => {
  it.each([
    ['node_modules', 'node_modules'],
    ['$RECYCLE.BIN', '$RECYCLE.BIN'],
    [' System Volume Information ', 'System Volume Information'],
    ['a/$b c/.DS_Store', 'a/$b c/.DS_Store'],
    ['  dist  ', 'dist'],
    ['packages\\app\\dist', 'packages/app/dist'],
    ['./a/', 'a'],
    ['././a', 'a'],
    ['.//a', 'a'],
    ['a//b///c', 'a/b/c'],
    ['a/b//', 'a/b'],
    ['.hidden', '.hidden'],
    ['a..b', 'a..b'],
    ['./././/cache///', 'cache'],
    [' .\\.\\cache\\ ', 'cache'],
    ['./parent/~cache', 'parent/~cache'],
    ['./parent/C:/cache', 'parent/C:/cache'],
    ['./ cache', 'cache'],
    ['./ ./\t./\ncache', 'cache'],
    ['cache /', 'cache'],
    ['cache/ /\t/\n/', 'cache'],
    [' ./ \t./cache / / ', 'cache'],
    ['./\u00a0cache\ufeff/\u00a0/', 'cache'],
    ['./ cache dir / nested folder / ', 'cache dir / nested folder'],
    ['./ cache\t name/ next  folder / ', 'cache\t name/ next  folder'],
  ])('normalizes %j to %j and keeps the result stable', (input, path) => {
    expect(normalizeRulePath(input)).toEqual({ kind: 'ok', path })
    expect(normalizeRulePath(path)).toEqual({ kind: 'ok', path })
    const preferences = { rules: [{ path, enabled: true }], showHidden: false, respectGitignore: true }
    expect(readSearchPreferences(preferences)).toEqual(preferences)
  })

  it('normalizes long mixed edge chains while preserving internal whitespace', () => {
    const path = 'cache dir / nested  folder'
    const input = `${'./ \t'.repeat(10_000)}${path}${' / \t'.repeat(10_000)}`
    const normalized = normalizeRulePath(input)
    expect(normalized.kind === 'ok' && normalized.path.length).toBe(path.length)
    expect(normalized).toEqual({ kind: 'ok', path })
    expect(normalizeRulePath(path)).toEqual({ kind: 'ok', path })
    const preferences = { rules: [{ path, enabled: false }], showHidden: true, respectGitignore: false }
    expect(readSearchPreferences(preferences)).toEqual(preferences)
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['./', 'empty'],
    ['.//', 'empty'],
    ['./ \t./ \n', 'empty'],
    ['./ . / ', 'parent'],
    ['a\0b', 'nul'],
    ['\0', 'nul'],
    ['/abs', 'absolute'],
    ['/', 'absolute'],
    ['///', 'absolute'],
    ['\\\\server\\share', 'absolute'],
    ['C:\\x', 'absolute'],
    ['c:x', 'absolute'],
    ['~/x', 'absolute'],
    ['~', 'absolute'],
    ['./~cache', 'absolute'],
    ['././~cache/', 'absolute'],
    ['.//./~/cache', 'absolute'],
    ['./C:/cache', 'absolute'],
    ['././c:cache/', 'absolute'],
    ['.\\.\\C:\\cache', 'absolute'],
    ['./ ~cache', 'absolute'],
    ['./ C:/cache', 'absolute'],
    ['./ ./\t~cache / /', 'absolute'],
    ['.\\ .\\ c:cache \\ ', 'absolute'],
    ['./ /cache', 'absolute'],
    [' ./ ./ / ', 'absolute'],
    [' \t/ ./ cache/ ', 'absolute'],
    ['./ ./ /\t/', 'absolute'],
    ['..', 'parent'],
    ['a/../b', 'parent'],
    ['a/..', 'parent'],
    ['.', 'parent'],
    ['a/./b', 'parent'],
    ['a/.', 'parent'],
    ['*.log', 'glob'],
    ['a?', 'glob'],
    ['[ab]', 'glob'],
    ['a]', 'glob'],
    ['{a,b}', 'glob'],
    ['a}', 'glob'],
    ['!dist', 'glob'],
  ])('refuses %j as %s', (input, reason) => {
    expect(normalizeRulePath(input)).toEqual({ kind: 'invalid', reason })
  })
})

describe('rule list', () => {
  it('starts from every default, enabled, in default order', () => {
    expect(defaultRules()).toEqual(DEFAULTS.map(path => ({ path, enabled: true })))
    expect(enabledPaths(defaultRules())).toEqual(DEFAULTS)
    expect(defaultSearchPreferences()).toEqual({ rules: defaultRules(), showHidden: false, respectGitignore: true })
    expect(defaultRules()).not.toBe(defaultRules())
    // Every default is a path the reader could type, unchanged by normalization.
    expect(DEFAULTS.map(path => normalizeRulePath(path))).toEqual(DEFAULTS.map(path => ({ kind: 'ok', path })))
  })

  it('adds a normalized rule at the top, enabled', () => {
    const rules: ExclusionRule[] = [{ path: 'dist', enabled: true }]
    expect(addRule(rules, ' ./out/ ')).toEqual({ kind: 'ok', rules: [{ path: 'out', enabled: true }, { path: 'dist', enabled: true }] })
    expect(rules).toEqual([{ path: 'dist', enabled: true }])
  })

  it('refuses an invalid rule without changing the list', () => {
    expect(addRule([], 'a/../b')).toEqual({ kind: 'invalid', reason: 'parent' })
  })

  it('enables and moves an existing rule to the top instead of listing it twice', () => {
    const rules: ExclusionRule[] = [{ path: 'a', enabled: true }, { path: 'b', enabled: true }, { path: 'dist', enabled: false }]
    expect(addRule(rules, 'dist/')).toEqual({
      kind: 'ok', rules: [{ path: 'dist', enabled: true }, { path: 'a', enabled: true }, { path: 'b', enabled: true }],
    })
    expect(addRule(rules, 'b')).toEqual({
      kind: 'ok', rules: [{ path: 'b', enabled: true }, { path: 'a', enabled: true }, { path: 'dist', enabled: false }],
    })
  })

  it('removes one rule and leaves others', () => {
    const rules: ExclusionRule[] = [{ path: 'a', enabled: true }, { path: 'b', enabled: false }]
    expect(removeRule(rules, 'b')).toEqual([{ path: 'a', enabled: true }])
    expect(removeRule(rules, 'c')).toEqual(rules)
  })

  it('switches one rule on or off in place', () => {
    const rules: ExclusionRule[] = [{ path: 'a', enabled: true }, { path: 'b', enabled: true }]
    const off = setRuleEnabled(rules, 'a', false)
    expect(off).toEqual([{ path: 'a', enabled: false }, { path: 'b', enabled: true }])
    expect(off[1]).toBe(rules[1])
    expect(setRuleEnabled(off, 'a', true)).toEqual(rules)
    expect(setRuleEnabled(rules, 'a', true)[0]).toBe(rules[0])
    expect(setRuleEnabled(rules, 'c', false)).toEqual(rules)
    expect(enabledPaths(off)).toEqual(['b'])
  })

  it('treats only the default list, in default order and fully enabled, as the defaults', () => {
    expect(isDefaultRules(defaultRules())).toBe(true)
    expect(isDefaultRules(removeRule(defaultRules(), 'dist'))).toBe(false)
    expect(isDefaultRules(setRuleEnabled(defaultRules(), '.git', false))).toBe(false)
    const added = addRule(defaultRules(), 'out')
    expect(added.kind === 'ok' && isDefaultRules(added.rules)).toBe(false)
    // Adding a listed default again moves it to the top, which differs from the default order.
    const moved = addRule(defaultRules(), 'dist')
    expect(moved.kind === 'ok' && isDefaultRules(moved.rules)).toBe(false)
    expect(isDefaultRules([])).toBe(false)
  })
})

describe('readSearchPreferences', () => {
  it('reads stored preferences back', () => {
    const preferences = { rules: [{ path: 'out', enabled: false }, { path: 'dist', enabled: true }], showHidden: true, respectGitignore: false }
    expect(readSearchPreferences(JSON.parse(JSON.stringify(preferences)))).toEqual(preferences)
  })

  it('keeps a stored empty list', () => {
    const preferences = { rules: [], showHidden: false, respectGitignore: true }
    expect(readSearchPreferences(preferences)).toEqual(preferences)
  })

  it.each([
    ['no rules', { showHidden: true, respectGitignore: false }, { showHidden: true, respectGitignore: false }],
    ['rules that are not an array', { rules: {}, showHidden: true }, { showHidden: true }],
    ['no showHidden', { rules: [] }, { rules: [] }],
    ['a showHidden that is not a boolean', { rules: [], showHidden: 'yes' }, { rules: [] }],
    ['no .gitignore choice', { rules: [{ path: 'out', enabled: false }], showHidden: true }, { rules: [{ path: 'out', enabled: false }], showHidden: true }],
    ['a .gitignore choice that is a string', { respectGitignore: 'no' }, {}],
    ['a .gitignore choice that is a JSON null', { respectGitignore: null }, {}],
  ])('gives %s its default alone, keeping the other fields', (_label, stored, kept) => {
    expect(readSearchPreferences(stored)).toEqual({ ...defaultSearchPreferences(), ...kept })
  })

  it.each([
    ['nothing stored', undefined],
    ['a JSON null', null],
    ['a JSON string', 'dist'],
    ['an array', []],
  ])('falls back to the defaults for %s', (_label, stored) => {
    expect(readSearchPreferences(stored)).toEqual(defaultSearchPreferences())
  })

  it('drops malformed, invalid, and repeated rules and normalizes the rest', () => {
    const stored = {
      rules: [
        null, 'dist', { path: 'a' }, { enabled: true }, { path: 1, enabled: true }, { path: 'b', enabled: 'yes' },
        { path: '../x', enabled: true }, { path: '*.log', enabled: true }, { path: '/abs', enabled: true }, { path: 'a\0b', enabled: true },
        { path: './out/', enabled: false }, { path: 'out', enabled: true }, { path: 'a\\b', enabled: true },
      ],
      showHidden: false,
    }
    expect(readSearchPreferences(stored)).toEqual({
      rules: [{ path: 'out', enabled: false }, { path: 'a/b', enabled: true }], showHidden: false, respectGitignore: true,
    })
  })
})

describe('changedSearchPreferences', () => {
  it('keeps only the fields that differ from the defaults, rule order and enabled state included', () => {
    const defaults = defaultSearchPreferences()
    expect(changedSearchPreferences(defaults)).toBeUndefined()
    expect(changedSearchPreferences({ ...defaults, showHidden: true })).toEqual({ showHidden: true })
    expect(changedSearchPreferences({ ...defaults, respectGitignore: false })).toEqual({ respectGitignore: false })
    expect(changedSearchPreferences({ ...defaults, rules: defaults.rules.slice(1) })).toEqual({ rules: defaults.rules.slice(1) })
    const reversed = [...defaults.rules].reverse()
    expect(changedSearchPreferences({ ...defaults, rules: reversed })).toEqual({ rules: reversed })
    const disabled = setRuleEnabled(defaults.rules, 'dist', false)
    expect(changedSearchPreferences({ rules: disabled, showHidden: true, respectGitignore: false }))
      .toEqual({ rules: disabled, showHidden: true, respectGitignore: false })
  })
})

describe('isHiddenEntry', () => {
  it.each([
    [{ name: '.env' }, true],
    [{ name: '.git' }, true],
    [{ name: 'desktop.ini' }, false],
    [{ name: 'src' }, false],
    [{ name: 'a.b' }, false],
  ])('%j is hidden: %s', (entry, hidden) => {
    expect(isHiddenEntry(entry)).toBe(hidden)
  })
})
