/** The workspace navigator's listed levels as the file tree's entries and directory states. */
import { describe, expect, it } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import type { FilesTreeState } from '../src/client/store.ts'
import { parentOf, treeRootOf, workspaceDirectories, workspaceEntries } from '../src/client/workspace-tree.ts'

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
    expect(workspaceEntries(tree.levels)).toEqual([
      { path: `${key}/src`, name: 'src', meta: { kind: 'directory' } },
      { path: `${key}/pipe`, name: 'pipe', meta: { kind: 'other' } },
      { path: `${key}/src/a.ts`, name: 'a.ts', meta: { kind: 'file' } },
    ])
    expect(parentOf(tree, `${key}/src`)).toBe(root)
    expect(parentOf(tree, `${key}/src/lib`)).toBe(`${key}/src`)
    expect(Object.keys(workspaceDirectories(tree, t))).toEqual([key, `${key}/src`])
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
    }, t)
    expect(states).toEqual({
      '/r': { failure: zh['error.notFound'], truncated: true },
      '/r/a': { loading: true },
      '/r/b': { loading: true },
      '/r/c': { failure: zh['error.notFound'] },
      '/r/d': {},
    })
  })
})
