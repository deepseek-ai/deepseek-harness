/** The `list` endpoint: file-kind gates, the workspace check for directories, and the entry cap. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
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

/** Create a link to a directory: a Windows junction where junctions exist, a directory symlink elsewhere. */
const directoryLink = (target: string, link: string): Promise<void> =>
  symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')

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

  it('lists a directory link whose target is inside the workspace', async () => {
    await mkdir(join(workspace, 'real-dir'))
    await writeFile(join(workspace, 'real-dir', 'child.txt'), 'x', 'utf8')
    await directoryLink(join(workspace, 'real-dir'), join(workspace, 'dir-link'))
    const listing = await endpoint().list(harness.scope, 'dir-link', signal())
    expect(listing.path).toBe('real-dir')
    expect(listing.entries).toEqual([{ name: 'child.txt', type: 'file', size: 1 }])
  })

  it('lists a directory link that resolves outside the workspace, and the directories below it, by the requested path', async () => {
    await mkdir(join(outside, 'nested'))
    await writeFile(join(outside, 'nested', 'child.txt'), 'x', 'utf8')
    await directoryLink(outside, join(workspace, 'escape'))
    const link = await endpoint().list(harness.scope, 'escape', signal())
    expect(link).toEqual({ path: 'escape', entries: [{ name: 'nested', type: 'directory' }], truncated: false })
    const nested = await endpoint().list(harness.scope, join(workspace, 'escape', 'nested'), signal())
    expect(nested).toEqual({ path: 'escape/nested', entries: [{ name: 'child.txt', type: 'file', size: 1 }], truncated: false })
  })

  it('lists a link cycle outside the workspace level by level until the platform refuses the path', async () => {
    await directoryLink(outside, join(workspace, 'escape'))
    await directoryLink(outside, join(outside, 'again'))
    const listing = await endpoint().list(harness.scope, 'escape/again/again', signal())
    expect(listing).toEqual({ path: 'escape/again/again', entries: [{ name: 'again', type: 'directory' }], truncated: false })
    // No cycle is detected: each level lists again, and the platform's limit on links in one path ends the descent.
    const descend = async (path: string, depth: number): Promise<{ depth: number; refusal: unknown }> => {
      const refusal = await endpoint().list(harness.scope, path, signal()).then(() => undefined, (error: unknown) => error)
      return refusal !== undefined || depth === 128 ? { depth, refusal } : descend(`${path}/again`, depth + 1)
    }
    const end = await descend('escape/again', 1)
    expect(end.refusal).toBeInstanceOf(Error)
    expect(end.depth).toBeGreaterThan(2)
  })

  it('names a workspace directory by its resolved position when a link outside the workspace leads back to it', async () => {
    await mkdir(join(workspace, 'src'))
    await directoryLink(outside, join(workspace, 'escape'))
    await directoryLink(join(workspace, 'src'), join(outside, 'back'))
    const listing = await endpoint().list(harness.scope, 'escape/back', signal())
    expect(listing).toEqual({ path: 'src', entries: [], truncated: false })
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

  // Windows drops `link/..` from the written path before any link is followed, so there it names the workspace root.
  it.skipIf(process.platform === 'win32')('rejects a `..` segment after a directory link that resolves outside the workspace', async () => {
    await directoryLink(outside, join(workspace, 'escape'))
    for (const path of ['escape/..', `${workspace}/escape/..`]) {
      const failure = await failureOf(endpoint().list(harness.scope, path, signal()))
      expect(failure).toEqual({ code: 'workspace-file/outside-workspace', details: { path } })
    }
  })

  it('rejects the home directory, which the backend expands from `~` without any link in the workspace', async () => {
    for (const path of ['~', '~/']) {
      const failure = await failureOf(endpoint().list(harness.scope, path, signal()))
      expect(failure).toEqual({ code: 'workspace-file/outside-workspace', details: { path } })
    }
  })

  it('rejects a directory link whose target is gone', async () => {
    await mkdir(join(workspace, 'vanishing'))
    await directoryLink(join(workspace, 'vanishing'), join(workspace, 'dangling'))
    await rm(join(workspace, 'vanishing'), { recursive: true })
    const failure = await failureOf(endpoint().list(harness.scope, 'dangling', signal()))
    expect(failure.code).toBe('workspace-file/not-directory')
    expect(failure.details).toMatchObject({ path: 'dangling', kind: 'symlink' })
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
