/** Search results synthesized into a fully expanded tree, their count, and in-name highlights. */
import { describe, expect, it } from 'vitest'
import { buildSearchTree, matchRanges } from '../src/client/search-tree.ts'
import type { SearchMatch } from '../src/client/search-tree.ts'

const ROOT = '/work/app'

describe('buildSearchTree', () => {
  it('synthesizes every ancestor level and expands all of them', () => {
    const tree = buildSearchTree(ROOT, [
      { path: 'src/search/index.ts', type: 'file' },
      { path: 'src/search.ts', type: 'file' },
      { path: 'notes/search.txt', type: 'file' },
    ])
    expect(tree).toEqual({
      autoRefresh: false,
      root: ROOT,
      levels: {
        [ROOT]: { kind: 'ready', level: { entries: [{ name: 'src', type: 'directory' }, { name: 'notes', type: 'directory' }], truncated: false } },
        '/work/app/src': { kind: 'ready', level: { entries: [{ name: 'search', type: 'directory' }, { name: 'search.ts', type: 'file' }], truncated: false } },
        '/work/app/src/search': { kind: 'ready', level: { entries: [{ name: 'index.ts', type: 'file' }], truncated: false } },
        '/work/app/notes': { kind: 'ready', level: { entries: [{ name: 'search.txt', type: 'file' }], truncated: false } },
      },
      expanded: [ROOT, '/work/app/src', '/work/app/src/search', '/work/app/notes'],
    })
  })

  it('gives a matched directory without matched descendants an empty level', () => {
    const tree = buildSearchTree(ROOT, [{ path: 'lib/search', type: 'directory' }, { path: 'odd', type: 'other' }])
    expect(tree.levels['/work/app/lib/search']).toEqual({ kind: 'ready', level: { entries: [], truncated: false } })
    expect(tree.levels[ROOT]).toEqual({ kind: 'ready', level: { entries: [{ name: 'lib', type: 'directory' }, { name: 'odd', type: 'other' }], truncated: false } })
    expect(tree.expanded).toEqual([ROOT, '/work/app/lib', '/work/app/lib/search'])
  })

  it('lists each child once and keeps a matched directory that also has matched descendants', () => {
    const entries: SearchMatch[] = [
      { path: 'search', type: 'directory' },
      { path: 'search/a.ts', type: 'file' },
      { path: 'search/a.ts', type: 'file' },
    ]
    const tree = buildSearchTree(ROOT, entries)
    expect(tree.levels[ROOT]).toEqual({ kind: 'ready', level: { entries: [{ name: 'search', type: 'directory' }], truncated: false } })
    expect(tree.levels['/work/app/search']).toEqual({ kind: 'ready', level: { entries: [{ name: 'a.ts', type: 'file' }], truncated: false } })
  })

  it('treats a name as a directory once any result passes through it, keeping its first position', () => {
    const tree = buildSearchTree(ROOT, [{ path: 'x', type: 'file' }, { path: 'y', type: 'file' }, { path: 'x/z', type: 'file' }])
    expect(tree.levels[ROOT]).toEqual({ kind: 'ready', level: { entries: [{ name: 'x', type: 'directory' }, { name: 'y', type: 'file' }], truncated: false } })
    expect(buildSearchTree(ROOT, [{ path: 'x/z', type: 'file' }, { path: 'x', type: 'file' }]).levels[ROOT])
      .toEqual({ kind: 'ready', level: { entries: [{ name: 'x', type: 'directory' }], truncated: false } })
  })

  it('joins paths the way the listed tree does, whatever the root spelling', () => {
    const windows = buildSearchTree('C:\\work\\', [{ path: 'a/b.txt', type: 'file' }])
    expect(windows.expanded).toEqual(['C:\\work\\', 'C:\\work/a'])
    expect(buildSearchTree('/', [{ path: 'etc/x', type: 'file' }]).expanded).toEqual(['/', '/etc'])
  })

  it('draws no results as an expanded empty root', () => {
    expect(buildSearchTree(ROOT, [])).toEqual({
      autoRefresh: false, root: ROOT, levels: { [ROOT]: { kind: 'ready', level: { entries: [], truncated: false } } }, expanded: [ROOT],
    })
  })
})

describe('matchRanges', () => {
  it('finds every non-overlapping occurrence regardless of case', () => {
    expect(matchRanges('Search-search.SEARCH', 'search')).toEqual([[0, 6], [7, 13], [14, 20]])
    expect(matchRanges('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
  })

  it('treats the query literally', () => {
    expect(matchRanges('a.b(c)*', '.b(c)*')).toEqual([[1, 7]])
    expect(matchRanges('axb', '.')).toEqual([])
  })

  it('has no ranges for an empty query or a miss', () => {
    expect(matchRanges('name', '')).toEqual([])
    expect(matchRanges('name', 'src/name')).toEqual([])
  })

  it('indexes the name as given around non-ASCII text', () => {
    expect(matchRanges('Größe.TXT', 'größe')).toEqual([[0, 5]])
    expect(matchRanges('报告-搜索.md', '搜索')).toEqual([[3, 5]])
  })
})
