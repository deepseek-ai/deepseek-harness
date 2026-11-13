/**
 * Search index contract: fuzzy and substring keys, every query term required,
 * multilingual values, folding, stable ranking, and updates.
 */
import { describe, expect, it } from 'vitest'
import { localizedValues, TextSearchIndex, type SearchKeys } from '../src/index.ts'

interface Row { readonly id: string; readonly title?: string; readonly description?: string }

const rows: readonly Row[] = [
  { id: 'compact', title: 'Compact context', description: 'Summarize earlier turns to free model context' },
  { id: 'clipboard-paste', title: 'Clipboard paste', description: 'Paste images and text into the composer' },
  { id: 'computer-use', title: 'Computer use', description: 'Control the mouse, keyboard, and screen' },
  { id: 'session-title', title: 'Session title', description: 'Generate a title for each session with a model' },
]
const keys = (row: Row): SearchKeys => ({ fuzzy: [row.id, row.title], substring: [row.description] })
const search = <T>(items: readonly T[], query: string, itemKeys: (item: T) => SearchKeys): readonly T[] =>
  new TextSearchIndex(items, itemKeys).search(query)
const ids = (query: string, items: readonly Row[] = rows) => search(items, query, keys).map(row => row.id)

describe('localizedValues', () => {
  it('returns every language of a localized value', () => {
    expect(localizedValues(undefined)).toEqual([])
    expect(localizedValues('Plain')).toEqual(['Plain'])
    expect(localizedValues({ en: 'Filter', zh: '筛选' })).toEqual(['Filter', '筛选'])
  })
})

describe('TextSearchIndex.search', () => {
  it('returns the build list itself for a blank query', () => {
    expect(search(rows, '   ', keys)).toBe(rows)
  })

  it('matches fuzzy keys as fuzzy subsequences', () => {
    expect(ids('cpt')).toEqual(expect.arrayContaining(['compact', 'computer-use']))
    expect(ids('cpt')).not.toContain('session-title')
    expect(ids('xyz')).toEqual([])
  })

  it('ranks fuzzy-key prefixes, then fuzzy-key substrings, then fuzzy subsequences, then substring keys', () => {
    const items: readonly Row[] = [
      { id: 'notes', description: 'Keep model notes' },
      { id: 'mxoxdxexl' },
      { id: 'big-model' },
      { id: 'model-list' },
    ]
    expect(ids('model', items)).toEqual(['model-list', 'big-model', 'mxoxdxexl', 'notes'])
  })

  it('orders fuzzy subsequence hits by fuzzysort score', () => {
    // Word starts outrank letters scattered inside one word.
    expect(ids('ftr', [{ id: 'filter' }, { id: 'f-t-r-x' }])).toEqual(['f-t-r-x', 'filter'])
  })

  it('keeps build order among equal matches', () => {
    const items: readonly Row[] = [{ id: 'open-z' }, { id: 'open-a' }, { id: 'x-open' }]
    expect(ids('open', items)).toEqual(['open-z', 'open-a', 'x-open'])
  })

  it('accepts a fuzzy subsequence hit only when it starts at a word start', () => {
    const items: readonly Row[] = [
      { id: 'refactor', title: 'Refactor build pipeline' },
      { id: 'flash', title: 'DeepSeekFlash' },
      { id: 'zh', title: '插件筛选' },
    ]
    expect(ids('fab', items)).toEqual([])
    expect(ids('rbp', items)).toEqual(['refactor'])
    expect(ids('sflsh', items)).toEqual(['flash'])
    expect(ids('件选', items)).toEqual(['zh'])
    // A word start after a separator also begins a match.
    expect(ids('bz', [{ id: 'foo-bar baz' }])).toEqual(['foo-bar baz'])
  })

  it('finds a word-start match when an earlier letter mid-word would align first', () => {
    // fuzzysort aligns `plg` on the `p` inside `Open` and `cpt` on the `c` inside `Script`.
    expect(ids('plg', [{ id: 'Open plugin manager' }])).toEqual(['Open plugin manager'])
    expect(ids('cpt', [{ id: 'Script compact' }])).toEqual(['Script compact'])
  })

  it('scores every term of a multi-term query against the same key', () => {
    // Both terms reach the fuzzy tier on one name and share its word starts.
    expect(ids('plgn mngr', [{ id: 'Open plugin manager' }, { id: 'Open plugin list' }])).toEqual(['Open plugin manager'])
    expect(ids('plgn plg', [{ id: 'Open plugin manager' }])).toEqual(['Open plugin manager'])
  })

  it('matches opaque ids passed as substring keys only by substring', () => {
    const items: readonly Row[] = [
      { id: 'title-only', description: 'session-3f2a9c1d-77aa-4b1e-9d0e-5a6b7c8d9e0f' },
      { id: 'other', description: 'session-a1b2c3d4-0000-4000-8000-000000000000' },
    ]
    expect(ids('a1', items)).toEqual(['other'])
    expect(ids('3f2a9c', items)).toEqual(['title-only'])
  })

  it('matches substring keys only as contiguous substrings', () => {
    expect(ids('mouse')).toEqual(['computer-use'])
    // The letters of "invoice" occur in order across the long descriptions, but nowhere contiguously.
    expect(ids('invoice')).toEqual([])
  })

  it('requires every query term to match some key', () => {
    expect(ids('paste composer')).toEqual(['clipboard-paste'])
    expect(ids('paste mouse')).toEqual([])
  })

  it('matches every language of localized values', () => {
    const items = [
      { id: 'plugin-filter', title: { en: 'Plugin filter', zh: '插件筛选' }, description: { en: 'Filter by name', zh: '按名称筛选' } },
    ]
    const localizedKeys = (item: typeof items[number]): SearchKeys => ({
      fuzzy: [item.id, ...localizedValues(item.title)],
      substring: localizedValues(item.description),
    })
    expect(search(items, '筛选', localizedKeys)).toEqual(items)
    expect(search(items, '名称', localizedKeys)).toEqual(items)
    expect(search(items, 'plugin 筛选', localizedKeys)).toEqual(items)
    expect(search(items, '选筛', localizedKeys)).toEqual([])
  })

  it('ignores case, width, and diacritics', () => {
    const items: readonly Row[] = [{ id: 'ＷＥＢ-search', description: 'Café résumé' }]
    expect(ids('web', items)).toEqual(['ＷＥＢ-search'])
    expect(ids('WEB', items)).toEqual(['ＷＥＢ-search'])
    expect(ids('cafe', items)).toEqual(['ＷＥＢ-search'])
    expect(ids('RESUME', items)).toEqual(['ＷＥＢ-search'])
  })

  it('applies the same normalization to fuzzy subsequence matches', () => {
    expect(ids('ｃｐｔ', [{ id: 'Compact' }])).toEqual(['Compact'])
    expect(ids('wb', [{ id: 'ＷＥＢ-search' }])).toEqual(['ＷＥＢ-search'])
    // A decomposed query and a composed name match alike.
    expect(ids('re\u0301sm', [{ id: 'Résumé' }])).toEqual(['Résumé'])
    expect(ids('resm', [{ id: 'Résumé' }])).toEqual(['Résumé'])
    // Stroked letters fold to their base letter on both paths.
    expect(ids('lodz', [{ id: 'Łódź' }])).toEqual(['Łódź'])
    expect(ids('ostf', [{ id: 'Østfold' }])).toEqual(['Østfold'])
    expect(ids('mlg', [{ id: 'Małgorzata' }])).toEqual(['Małgorzata'])
    // A kana voicing mark changes the letter, so `か` does not find `が`.
    expect(ids('か', [{ id: 'が' }])).toEqual([])
  })

  it('treats a term made only of combining marks as no term', () => {
    const items: readonly Row[] = [{ id: 'alpha' }, { id: 'beta' }]
    expect(search(items, '\u0301', row => ({ fuzzy: [row.id] }))).toBe(items)
    expect(ids('\u0301 beta', items)).toEqual(['beta'])
  })

  it('finds word starts by code point, including characters outside the BMP', () => {
    // 𠀀 (U+20000) is a Han character stored as a surrogate pair.
    expect(ids('𠀀b', [{ id: '中𠀀x-b' }])).toEqual(['中𠀀x-b'])
    expect(ids('x𠀀', [{ id: 'a 𠀀' }])).toEqual([])
  })

  it('skips absent and empty values', () => {
    const items: readonly Row[] = [{ id: '' }, { id: 'kept', title: '' }]
    expect(search(items, 'kept', row => ({ fuzzy: [row.id, row.title, undefined], substring: [undefined, ''] }))).toEqual([items[1]])
    expect(search(items, 'kept', () => ({}))).toEqual([])
  })
})

describe('TextSearchIndex.update', () => {
  it('searches the complete new list, with removed items gone and added items found', () => {
    const index = new TextSearchIndex(rows, keys)
    const kept = rows.filter(row => row.id !== 'compact')
    const added: Row = { id: 'context-window', title: 'Context window' }
    const next = index.update([...kept, added], keys)
    expect(next.search('cpt').map(row => row.id)).not.toContain('compact')
    expect(next.search('ctx').map(row => row.id)).toEqual(['context-window'])
    expect(next.search('')).toEqual([...kept, added])
  })

  it('reads changed keys and leaves the earlier index unchanged', () => {
    const index = new TextSearchIndex(rows, keys)
    const renamed = rows.map(row => row.id === 'compact' ? { ...row, id: 'shrink', title: 'Shrink history' } : row)
    const next = index.update(renamed, keys)
    expect(next.search('shrnk').map(row => row.id)).toEqual(['shrink'])
    expect(next.search('cmpct')).toEqual([])
    expect(index.search('cmpct').map(row => row.id)).toEqual(['compact'])
    expect(index.search('')).toBe(rows)
  })

  it('returns what a fresh build of the same list returns', () => {
    // Searches on the earlier index fill in word starts and fuzzysort targets that the update then reuses.
    const index = new TextSearchIndex(rows, keys)
    const queries = ['cpt', 'model', 'mouse', 'paste composer', 'ses tit']
    for (const query of queries) index.search(query)
    const changed = [...rows].reverse().filter(row => row.id !== 'computer-use')
    const next = index.update(changed, keys)
    const fresh = new TextSearchIndex(changed, keys)
    for (const query of queries) expect(next.search(query)).toEqual(fresh.search(query))
  })

  it('reads keys only while building', () => {
    let calls = 0
    const counted = (row: Row): SearchKeys => { calls += 1; return keys(row) }
    const index = new TextSearchIndex(rows, counted)
    index.search('cpt')
    index.search('model')
    expect(calls).toBe(rows.length)
    index.update(rows, counted)
    expect(calls).toBe(rows.length * 2)
  })
})
