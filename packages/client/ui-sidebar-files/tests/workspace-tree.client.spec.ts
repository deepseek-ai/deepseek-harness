/** The workspace navigator's listed levels as the file tree's entries and directory states. */
import { describe, expect, it } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import type { FilesTreeState } from '../src/client/store.ts'
import { parentOf, searchDirectories, treeRootOf, workspaceDirectories, workspaceEntries } from '../src/client/workspace-tree.ts'

const t = makeTranslate(zh)

/** A tree at `root` with `src` listed below it. */
function listed(root: string): FilesTreeState {
  const top = treeRootOf(root)
  return {
    root, autoRefresh: true, expanded: [root, `${top}/src`],
    levels: {
      [root]: { kind: 'ready', level: { entries: [{ name: 'src', type: 'directory' }, { name: 'pipe', type: 'other' }], truncated: false } },
      [`${top}/src`]: { kind: 'ready', level: { entries: [{ name: 'a.ts', type: 'file' }], truncated: false } },
    },
  }
}

describe('workspace tree keys', () => {
  it.each([
    ['/work/app', '/work/app'],
    ['/work/app/', '/work/app'],
    ['/', ''],
    ['C:\\', 'C:'],
    ['C:\\repo', 'C:\\repo'],
    ['\\\\server\\share\\', '\\\\server\\share'],
  ])('keys root %j as %j, its entries one slash below it, and their parents back to the root as stored', (root, key) => {
    const tree = listed(root)
    expect(workspaceEntries(tree.levels, false)).toEqual([
      { path: `${key}/src`, name: 'src', meta: { kind: 'directory' } },
      { path: `${key}/pipe`, name: 'pipe', meta: { kind: 'other' } },
      { path: `${key}/src/a.ts`, name: 'a.ts', meta: { kind: 'file' } },
    ])
    expect(parentOf(tree, `${key}/src`)).toBe(root)
    expect(parentOf(tree, `${key}/src/lib`)).toBe(`${key}/src`)
    expect(Object.keys(workspaceDirectories(tree, t, false))).toEqual([key, `${key}/src`])
    expect(Object.keys(searchDirectories(tree))).toEqual([key, `${key}/src`])
  })
})

describe('workspaceDirectories', () => {
  it('reports a directory loading until its first listing, then its failure and truncation', () => {
    const failure = new RemoteError('workspace-file/not-found', 'gone', { path: '/r' })
    const states = workspaceDirectories({
      root: '/r',
      expanded: ['/r', '/r/a', '/r/b', '/r/c', '/r/d'],
      levels: {
        '/r': { kind: 'ready', level: { entries: [], truncated: true }, failure, refreshing: true },
        '/r/b': { kind: 'loading' },
        '/r/c': { kind: 'failed', failure },
        '/r/d': { kind: 'ready', level: { entries: [], truncated: false } },
      },
    }, t, false)
    expect(states).toEqual({
      '/r': { failure: zh['error.notFound'], truncated: true },
      '/r/a': { loading: true },
      '/r/b': { loading: true },
      '/r/c': { failure: zh['error.notFound'] },
      '/r/d': {},
    })
  })
})

describe('hidden entries', () => {
  const tree: FilesTreeState = {
    root: '/r', autoRefresh: true, expanded: ['/r', '/r/.git'],
    levels: {
      '/r': { kind: 'ready', level: { entries: [{ name: '.git', type: 'directory' }, { name: 'a.ts', type: 'file' }], truncated: false } },
      '/r/.git': { kind: 'ready', level: { entries: [{ name: '.keep', type: 'file' }], truncated: false } },
    },
  }

  it('leaves them out, and says a directory of only hidden entries holds some, until they are shown', () => {
    expect(workspaceEntries(tree.levels, false).map(entry => entry.path)).toEqual(['/r/a.ts'])
    expect(workspaceDirectories(tree, t, false)).toEqual({ '/r': {}, '/r/.git': { omitted: 'hidden' } })
    expect(workspaceEntries(tree.levels, true).map(entry => entry.path)).toEqual(['/r/.git', '/r/a.ts', '/r/.git/.keep'])
    expect(workspaceDirectories(tree, t, true)).toEqual({ '/r': {}, '/r/.git': {} })
  })

  it('leaves out the kept levels below a hidden directory once hidden entries are no longer shown', () => {
    const levels: FilesTreeState['levels'] = {
      '/r': { kind: 'ready', level: { entries: [{ name: '.config', type: 'directory' }, { name: 'src', type: 'directory' }], truncated: false } },
      '/r/.config': { kind: 'ready', level: { entries: [{ name: 'app', type: 'directory' }, { name: 'config.json', type: 'file' }], truncated: false } },
      '/r/.config/app': { kind: 'ready', level: { entries: [{ name: 'a.json', type: 'file' }], truncated: false } },
      '/r/.configs': { kind: 'ready', level: { entries: [{ name: 'kept.json', type: 'file' }], truncated: false } },
      '/r/src': { kind: 'ready', level: { entries: [{ name: 'b.ts', type: 'file' }], truncated: false } },
    }
    // `.configs` shares the hidden directory's name as a prefix but is not below it.
    expect(workspaceEntries(levels, false).map(entry => entry.path)).toEqual(['/r/src', '/r/.configs/kept.json', '/r/src/b.ts'])
    expect(workspaceEntries(levels, true).map(entry => entry.path)).toContain('/r/.config/app/a.json')
  })

  it('draws a search result directory without matches below it as a selection', () => {
    expect(searchDirectories(tree)).toEqual({ '/r': { omitted: 'unmatched' }, '/r/.git': { omitted: 'unmatched' } })
  })
})
