/** The `list` endpoint: the same containment gates as `read`, plus the entry cap. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-list-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (caps?: { maxEntries?: number }): ReturnType<Harness['endpoint']> => harness.endpoint(caps)

describe('workspaceFiles.list — the happy path', () => {
  it('lists the root as the empty workspace path, with types and file sizes', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'notes.txt'), 'hello', 'utf8')
    await writeFile(join(workspace, '.hidden'), '', 'utf8')
    const listing = await endpoint().list(harness.scope, '.', signal())
    expect(listing.path).toBe('')
    expect(listing.truncated).toBe(false)
    expect(listing.entries).toEqual([
      { name: '.hidden', type: 'file', size: 0 },
      { name: 'notes.txt', type: 'file', size: 5 },
      { name: 'src', type: 'directory' },
    ])
  })

  it('accepts the absolute workspace root and reports the same empty path', async () => {
    const listing = await endpoint().list(harness.scope, workspace, signal())
    expect(listing.path).toBe('')
    expect(listing.entries).toEqual([])
  })

  it('reports a nested directory as its `/`-joined path relative to the root, decoded', async () => {
    await mkdir(join(workspace, 'src', 'my dir', '子目录'), { recursive: true })
    await writeFile(join(workspace, 'src', 'my dir', '子目录', 'a.ts'), '', 'utf8')
    const listing = await endpoint().list(harness.scope, 'src/my dir/子目录', signal())
    expect(listing.path).toBe('src/my dir/子目录')
    expect(listing.entries.map(entry => entry.name)).toEqual(['a.ts'])
  })

  it('reports a symlink child as what it points to, and a dangling one as other', async () => {
    await writeFile(join(workspace, 'real.txt'), 'x', 'utf8')
    await mkdir(join(workspace, 'dir'))
    await symlink(join(workspace, 'real.txt'), join(workspace, 'to-file'))
    await symlink(join(workspace, 'dir'), join(workspace, 'to-dir'))
    await symlink(join(workspace, 'missing'), join(workspace, 'dangling'))
    const listing = await endpoint().list(harness.scope, '.', signal())
    expect(listing.entries).toEqual([
      { name: 'dangling', type: 'other' },
      { name: 'dir', type: 'directory' },
      { name: 'real.txt', type: 'file', size: 1 },
      { name: 'to-dir', type: 'directory' },
      { name: 'to-file', type: 'file', size: 1 },
    ])
  })
})

describe('workspaceFiles.list — the entry cap', () => {
  it('cuts at the cap in name order and says so', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(workspace, name), '', 'utf8')
    const listing = await endpoint({ maxEntries: 2 }).list(harness.scope, '.', signal())
    expect(listing.entries.map(entry => entry.name)).toEqual(['a', 'b'])
    expect(listing.truncated).toBe(true)
  })

  it('does not report a cut at exactly the cap', async () => {
    for (const name of ['a', 'b']) await writeFile(join(workspace, name), '', 'utf8')
    const listing = await endpoint({ maxEntries: 2 }).list(harness.scope, '.', signal())
    expect(listing.entries).toHaveLength(2)
    expect(listing.truncated).toBe(false)
  })
})

describe('workspaceFiles.list — gates', () => {
  it('rejects an absolute directory outside the workspace', async () => {
    const failure = await failureOf(endpoint().list(harness.scope, outside, signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })

  it('rejects a traversal that climbs out of the workspace', async () => {
    const failure = await failureOf(endpoint().list(harness.scope, '..', signal()))
    expect(failure.code).toBe('workspace-file/outside-workspace')
  })

  it('rejects a symlinked directory before following it, wherever it points', async () => {
    await symlink(outside, join(workspace, 'escape'))
    const failure = await failureOf(endpoint().list(harness.scope, 'escape', signal()))
    expect(failure.code).toBe('workspace-file/not-directory')
    expect(failure.details).toMatchObject({ kind: 'symlink' })
  })

  it('rejects a file, which has no children to list', async () => {
    await writeFile(join(workspace, 'notes.txt'), 'hello', 'utf8')
    const failure = await failureOf(endpoint().list(harness.scope, 'notes.txt', signal()))
    expect(failure.code).toBe('workspace-file/not-directory')
    expect(failure.details).toMatchObject({ path: 'notes.txt', kind: 'file' })
  })

  it('reports a missing path as not found', async () => {
    const failure = await failureOf(endpoint().list(harness.scope, 'nope', signal()))
    expect(failure.code).toBe('workspace-file/not-found')
  })

  it('refuses an empty path as a bad request', async () => {
    const failure = await failureOf(endpoint().list(harness.scope, '', signal()))
    expect(failure.code).toBe('gateway/bad-request')
  })
})
