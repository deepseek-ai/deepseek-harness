import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ForgeCommitList } from '@deepseek-ai/dsh-experimental-forge'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  ForgeExtensionState, ForgeLens, ForgeLensFrame, ForgeLensId, ForgeLensInput, ForgeLensRequest, ForgeLensResult,
} from '../src/index.ts'
import { lensVersion } from '../src/lens-version.ts'
import { bench, follow, git, hold, pullUrl, repository, scratch, shellTurn } from './harness.ts'
import type { Bench } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const signal = new AbortController().signal
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MERGE_BASE = 'c'.repeat(40)

async function project(): Promise<string> {
  const { path, remove } = await scratch('dsh-forge-lens-')
  cleanups.push(remove)
  const repo = await repository(path)
  await git(repo, 'remote', 'add', 'origin', 'https://fake.test/octo/demo.git')
  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return repo
}

async function open(repo: string, config: Parameters<typeof bench>[1] = {}): Promise<Bench> {
  const opened = await bench(repo, config)
  cleanups.push(() => opened.ctx.fiber.dispose())
  return opened
}

/** Register `lens` from its own plugin fiber, as a third-party plugin does. */
async function provideLens(ctx: Context, lens: ForgeLens): Promise<ReturnType<Context['plugin']>> {
  const fiber = ctx.plugin({ inject: ['forgePanel'], apply(child: Context) { child.forgePanel.registerLens(lens) } })
  await fiber
  return fiber
}

/** A lens that keeps the files whose new side contains `export`, about those lines, recording every side it read. */
function exportsLens(reads: string[] = [], id = 'fixture/exports'): ForgeLens & { readonly classify: ReturnType<typeof vi.fn> } {
  return {
    id: id as ForgeLensId,
    version: '1',
    classify: vi.fn(async (input: ForgeLensInput): Promise<ForgeLensResult> => {
      const files: Record<string, { ranges: { old: { start: number; end: number }[]; new: { start: number; end: number }[] } }> = {}
      for (const [index, file] of input.files.entries()) {
        const old = await input.text('old', file.path, signal)
        const next = await input.text('new', file.path, signal)
        reads.push(`${file.path} old=${JSON.stringify(old)} new=${JSON.stringify(next)}`)
        input.progress(index + 1, input.files.length)
        const lines = (next ?? '').split('\n')
        const exported = lines.flatMap((line, at) => line.startsWith('export') ? [{ start: at + 1, end: at + 1 }] : [])
        if (exported.length > 0) files[file.path] = { ranges: { old: [], new: exported } }
      }
      return { files }
    }),
  }
}

/** Settle once `lensSignal` aborts, as a lens that stops its work when asked does. */
async function untilAborted(lensSignal: AbortSignal): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    lensSignal.addEventListener('abort', () => { reject(new Error('stopped')) }, { once: true })
  })
}

async function frames(ctx: Context, session: Session, request: ForgeLensRequest): Promise<ForgeLensFrame[]> {
  const list: ForgeLensFrame[] = []
  for await (const frame of ctx.forgePanel.changesLens(session, request, signal)) list.push(frame)
  return list
}

async function rejection(ctx: Context, session: Session, request: ForgeLensRequest): Promise<unknown> {
  try {
    await frames(ctx, session, request)
  } catch (error) {
    return error
  }
  throw new Error('the lens request succeeded')
}

describe('forgePanel lens registrations', () => {
  it('lists each registered lens while its plugin is loaded and withdraws it when the plugin unloads', async () => {
    const opened = await open(await project(), { maxAnnotationsPerFile: 7 })
    const controller = new AbortController()
    const states = opened.ctx.forgePanel.extensions(controller.signal)[Symbol.asyncIterator]()
    cleanups.push(async () => {
      controller.abort()
      await states.return?.()
    })
    const empty: ForgeExtensionState = { lenses: [], maxAnnotationsPerFile: 7 }
    await expect(states.next()).resolves.toEqual({ done: false, value: empty })

    const fiber = await provideLens(opened.ctx, exportsLens())
    await expect(states.next()).resolves.toEqual({ done: false, value: { lenses: [{ id: 'fixture/exports', version: '1' }], maxAnnotationsPerFile: 7 } })
    await expect(provideLens(opened.ctx, exportsLens())).rejects.toThrow('forge-panel: a lens "fixture/exports" is already registered')
    await fiber.dispose()
    await expect(states.next()).resolves.toEqual({ done: false, value: { lenses: [], maxAnnotationsPerFile: 7 } })
  })

  it('ends the extension stream when the panel stops', async () => {
    const opened = await open(await project())
    const states = opened.ctx.forgePanel.extensions(signal)[Symbol.asyncIterator]()
    await states.next()
    const waiting = states.next()
    await opened.panel.dispose()
    await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  })

  it('returns a disposer that withdraws the lens', async () => {
    const opened = await open(await project())
    const dispose = opened.ctx.forgePanel.registerLens(exportsLens())
    await dispose()
    const error = await rejection(opened.ctx, opened.session, { source: { kind: 'local', scope: { kind: 'unstaged' } }, version: '', lens: 'fixture/exports' })
    expect(error).toMatchObject({ code: 'forgePanel/lens-missing', message: 'No lens "fixture/exports" is registered' })
  })
})

describe('forgePanel lenses over local changes', () => {
  it('classifies the shown files with both sides read in the Session\'s checkout, then reuses the result', async () => {
    const repo = await project()
    await writeFile(join(repo, 'tracked.txt'), 'export const value = 1\n')
    await writeFile(join(repo, 'notes.md'), 'hello\n')
    await writeFile(join(repo, 'image.bin'), Buffer.from([0, 1, 2]))
    const opened = await open(repo)
    const reads: string[] = []
    const lens = exportsLens(reads)
    await provideLens(opened.ctx, lens)
    const scope = { kind: 'branch', base: null, commits: null } as const
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
    const request: ForgeLensRequest = { source: { kind: 'local', scope }, version: lensVersion(files), lens: 'fixture/exports' }

    const first = await frames(opened.ctx, opened.session, request)
    expect(first.at(-1)).toEqual({ kind: 'result', files: { 'tracked.txt': { ranges: { old: [], new: [{ start: 1, end: 1 }] } } } })
    expect(first.slice(0, -1).every(frame => frame.kind === 'progress' && frame.total === 3)).toBe(true)
    expect(first.length).toBeGreaterThan(1)
    expect(reads).toEqual([
      'tracked.txt old="initial\\n" new="export const value = 1\\n"',
      'image.bin old=null new=null',
      'notes.md old=null new="hello\\n"',
    ])
    expect(lens.classify.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'local', scope } })
    await expect(frames(opened.ctx, opened.session, request)).resolves.toEqual([
      { kind: 'result', files: { 'tracked.txt': { ranges: { old: [], new: [{ start: 1, end: 1 }] } } } },
    ])
    expect(lens.classify).toHaveBeenCalledTimes(1)
  })

  it('reads the old side at HEAD, at the index, and before the first chosen commit', async () => {
    const repo = await project()
    await writeFile(join(repo, 'tracked.txt'), 'staged\n')
    await git(repo, 'add', 'tracked.txt')
    await writeFile(join(repo, 'tracked.txt'), 'working\n')
    const opened = await open(repo)
    const reads: string[] = []
    await provideLens(opened.ctx, exportsLens(reads))
    const ask = async (scope: Extract<ForgeLensRequest['source'], { kind: 'local' }>['scope']): Promise<void> => {
      const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
      await frames(opened.ctx, opened.session, { source: { kind: 'local', scope }, version: lensVersion(files), lens: 'fixture/exports' })
    }
    await ask({ kind: 'branch', base: 'refs/remotes/origin/main', commits: null })
    await ask({ kind: 'uncommitted' })
    await ask({ kind: 'staged' })
    await ask({ kind: 'unstaged' })
    await git(repo, 'commit', '--quiet', '-m', 'staged')
    const commit = await git(repo, 'rev-parse', 'HEAD')
    await ask({ kind: 'branch', base: null, commits: { from: commit, to: commit } })
    expect(reads).toEqual([
      'tracked.txt old="initial\\n" new="working\\n"',
      'tracked.txt old="initial\\n" new="working\\n"',
      'tracked.txt old="initial\\n" new="staged\\n"',
      'tracked.txt old="staged\\n" new="working\\n"',
      'tracked.txt old="initial\\n" new="staged\\n"',
    ])
  })

  it('reads a renamed file\'s old side at its previous path and a deleted file\'s new side as missing', async () => {
    const repo = await project()
    await writeFile(join(repo, 'gone.txt'), 'gone\n')
    await git(repo, 'add', 'gone.txt')
    await git(repo, 'commit', '--quiet', '-m', 'add gone')
    await git(repo, 'mv', 'tracked.txt', 'moved.txt')
    await git(repo, 'rm', '--quiet', 'gone.txt')
    const opened = await open(repo)
    const reads: string[] = []
    await provideLens(opened.ctx, exportsLens(reads))
    const scope = { kind: 'staged' } as const
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
    await frames(opened.ctx, opened.session, { source: { kind: 'local', scope }, version: lensVersion(files), lens: 'fixture/exports' })
    expect(reads.sort()).toEqual(['gone.txt old="gone\\n" new=null', 'moved.txt old="initial\\n" new="initial\\n"'])
  })

  it('refuses a request for other files, maps a failed lens, and reports a lens withdrawn while it runs as missing', async () => {
    const repo = await project()
    await writeFile(join(repo, 'tracked.txt'), 'changed\n')
    const opened = await open(repo)
    const scope = { kind: 'unstaged' } as const
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
    const version = lensVersion(files)
    await provideLens(opened.ctx, { id: 'fixture/broken' as ForgeLensId, version: '1', classify: async () => { throw new Error('parser crashed') } })
    const started = Promise.withResolvers<undefined>()
    const slow = await provideLens(opened.ctx, {
      id: 'fixture/slow' as ForgeLensId,
      version: '1',
      classify: async (_input, lensSignal) => {
        started.resolve(undefined)
        return await untilAborted(lensSignal)
      },
    })

    await expect(rejection(opened.ctx, opened.session, { source: { kind: 'local', scope }, version: 'other', lens: 'fixture/broken' }))
      .resolves.toMatchObject({ code: 'forgePanel/lens-stale' })
    await expect(rejection(opened.ctx, opened.session, { source: { kind: 'local', scope }, version, lens: 'fixture/broken' }))
      .resolves.toMatchObject({ code: 'forgePanel/lens-failed', message: 'the lens failed: parser crashed' })
    const pending = rejection(opened.ctx, opened.session, { source: { kind: 'local', scope }, version, lens: 'fixture/slow' })
    await started.promise
    await slow.dispose()
    await expect(pending).resolves.toMatchObject({ code: 'forgePanel/lens-missing', message: 'the lens "fixture/slow" was unregistered' })
  })

  it('neither runs nor answers from memory for a lens withdrawn while the files are read', async () => {
    const repo = await project()
    await writeFile(join(repo, 'tracked.txt'), 'export const changed = 1\n')
    const opened = await open(repo)
    const lens = exportsLens()
    const plugin = await provideLens(opened.ctx, lens)
    const scope = { kind: 'unstaged' } as const
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
    const request: ForgeLensRequest = { source: { kind: 'local', scope }, version: lensVersion(files), lens: 'fixture/exports' }
    await frames(opened.ctx, opened.session, request)
    expect(lens.classify).toHaveBeenCalledTimes(1)

    const held = hold(opened.sandbox, 'diff')
    const pending = rejection(opened.ctx, opened.session, request)
    await held.reached
    await plugin.dispose()
    held.release()
    await expect(pending).resolves.toMatchObject({ code: 'forgePanel/lens-missing', message: 'No lens "fixture/exports" is registered' })
    expect(lens.classify).toHaveBeenCalledTimes(1)
  })

  it('neither sends nor keeps a result after the local files changed while the lens read them', async () => {
    const repo = await project()
    await writeFile(join(repo, 'tracked.txt'), 'export const value = 1\n')
    const opened = await open(repo)
    let edits = 0
    const classify = vi.fn(async (input: ForgeLensInput): Promise<ForgeLensResult> => {
      await input.text('new', 'tracked.txt', signal)
      if (edits === 0) {
        edits += 1
        await writeFile(join(repo, 'tracked.txt'), 'export const value = 2\n')
      }
      return { files: { 'tracked.txt': {} } }
    })
    await provideLens(opened.ctx, { id: 'fixture/editing' as ForgeLensId, version: '1', classify })
    const scope = { kind: 'unstaged' } as const
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
    const request: ForgeLensRequest = { source: { kind: 'local', scope }, version: lensVersion(files), lens: 'fixture/editing' }
    await expect(rejection(opened.ctx, opened.session, request))
      .resolves.toMatchObject({ code: 'forgePanel/lens-stale', message: 'The changes moved while the lens read them' })
    await writeFile(join(repo, 'tracked.txt'), 'export const value = 1\n')
    await expect(frames(opened.ctx, opened.session, request)).resolves.toEqual([{ kind: 'result', files: { 'tracked.txt': {} } }])
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('passes a cancellation of the reader on unchanged', async () => {
    const repo = await project()
    await writeFile(join(repo, 'tracked.txt'), 'changed\n')
    const opened = await open(repo)
    const scope = { kind: 'unstaged' } as const
    const { files } = await opened.ctx.forgePanel.localDiff(opened.session, scope, signal)
    const started = Promise.withResolvers<undefined>()
    await provideLens(opened.ctx, {
      id: 'fixture/slow' as ForgeLensId,
      version: '1',
      classify: async (_input, lensSignal) => {
        started.resolve(undefined)
        return await untilAborted(lensSignal)
      },
    })
    const controller = new AbortController()
    const iterator = opened.ctx.forgePanel.changesLens(opened.session, { source: { kind: 'local', scope }, version: lensVersion(files), lens: 'fixture/slow' },
      controller.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await started.promise
    controller.abort(new Error('view closed'))
    await expect(next).rejects.toThrow('view closed')
  })
})

describe('forgePanel lenses over change requests', () => {
  const PATCH = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-const a = 1', '+export const a = 1',
    'diff --git a/src/old.ts b/src/new.ts', 'similarity index 90%', 'rename from src/old.ts', 'rename to src/new.ts',
    '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -1 +1 @@', '-old', '+export new',
    'diff --git a/src/added.ts b/src/added.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/added.ts', '@@ -0,0 +1 @@', '+added',
    '',
  ].join('\n')

  async function bound(base: string | null = BASE): Promise<Bench> {
    const opened = await open(await project())
    opened.provider.overrides.set(7, { headSha: HEAD, ...base === null ? {} : { baseSha: base } })
    opened.provider.patches.set(7, PATCH)
    shellTurn(opened.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(7)}\n` }])
    const follower = follow(opened.ctx, opened.session)
    cleanups.push(follower.stop)
    await follower.until(state => state.changeRequests.some(entry => entry.snapshot !== null))
    return opened
  }

  it('reads the new side at the head and the old side at the merge base the provider names', async () => {
    const opened = await bound()
    const mergeBase = vi.fn(async () => MERGE_BASE)
    Object.assign(opened.provider, { mergeBase })
    opened.provider.texts.set(`${HEAD}:src/a.ts`, 'export const a = 1\n')
    opened.provider.texts.set(`${MERGE_BASE}:src/a.ts`, 'const a = 1\n')
    opened.provider.texts.set(`${HEAD}:src/new.ts`, 'export new\n')
    opened.provider.texts.set(`${MERGE_BASE}:src/old.ts`, 'old\n')
    const reads: string[] = []
    const lens = exportsLens(reads)
    await provideLens(opened.ctx, lens)
    const { files } = await opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), null, signal)

    const result = await frames(opened.ctx, opened.session,
      { source: { kind: 'change', url: pullUrl(7), commits: null }, version: lensVersion(files), lens: 'fixture/exports' })
    expect(result.at(-1)).toEqual({ kind: 'result', files: {
      'src/a.ts': { ranges: { old: [], new: [{ start: 1, end: 1 }] } },
      'src/new.ts': { ranges: { old: [], new: [{ start: 1, end: 1 }] } },
    } })
    expect(reads).toEqual([
      'src/a.ts old="const a = 1\\n" new="export const a = 1\\n"',
      'src/new.ts old="old\\n" new="export new\\n"',
      'src/added.ts old=null new=null',
    ])
    expect(mergeBase).toHaveBeenCalledTimes(1)
    expect(mergeBase).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }), BASE, HEAD, expect.any(AbortSignal))
    expect(lens.classify.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'change', headSha: HEAD, commits: null, ref: { number: 7 } } })
  })

  it('reads the old side of chosen commits at the first one\'s parent', async () => {
    const opened = await bound()
    const first = 'd'.repeat(40)
    const parent = 'e'.repeat(40)
    const list: ForgeCommitList = { headSha: HEAD, truncated: false, commits: [
      { sha: first, parent, title: 'first', author: null, authoredAt: '2026-11-01T00:00:00Z' },
      { sha: HEAD, parent: first, title: 'head', author: null, authoredAt: '2026-11-02T00:00:00Z' },
    ] }
    opened.provider.commitLists.set(7, list)
    opened.provider.comparisons.set(`${parent}..${first}`, PATCH)
    opened.provider.texts.set(`${parent}:src/a.ts`, 'parent\n')
    opened.provider.texts.set(`${first}:src/a.ts`, 'first\n')
    const reads: string[] = []
    await provideLens(opened.ctx, exportsLens(reads))
    const commits = { from: first, to: first }
    const { files } = await opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), commits, signal)

    await frames(opened.ctx, opened.session, { source: { kind: 'change', url: pullUrl(7), commits }, version: lensVersion(files), lens: 'fixture/exports' })
    expect(reads[0]).toBe('src/a.ts old="parent\\n" new="first\\n"')
    // A missing file reads as an absent side.
    expect(reads[1]).toBe('src/new.ts old=null new=null')
  })

  it('fails reads of an old side the provider cannot locate and retries a failed merge base lookup', async () => {
    const withoutBase = await bound(null)
    await provideLens(withoutBase.ctx, exportsLens())
    const { files } = await withoutBase.ctx.forgePanel.changeRequestDiff(withoutBase.session, pullUrl(7), null, signal)
    const request: ForgeLensRequest = { source: { kind: 'change', url: pullUrl(7), commits: null }, version: lensVersion(files), lens: 'fixture/exports' }
    await expect(rejection(withoutBase.ctx, withoutBase.session, request)).resolves.toMatchObject({
      code: 'forgePanel/lens-failed', message: 'the lens failed: The code host provider reports no base commit to read the old side at',
    })

    const flaky = await bound()
    const mergeBase = vi.fn()
      .mockResolvedValueOnce({ code: 'unavailable', message: 'compare failed' })
      .mockResolvedValue(MERGE_BASE)
    Object.assign(flaky.provider, { mergeBase })
    flaky.provider.texts.set(`${HEAD}:src/a.ts`, 'export const a = 1\n')
    flaky.provider.texts.set(`${MERGE_BASE}:src/a.ts`, 'const a = 1\n')
    await provideLens(flaky.ctx, {
      id: 'fixture/retry' as ForgeLensId,
      version: '1',
      classify: async (input) => {
        await expect(input.text('old', 'src/a.ts', signal)).rejects.toThrow('compare failed')
        expect(await input.text('old', 'src/a.ts', signal)).toBe('const a = 1\n')
        return { files: {} }
      },
    })
    await expect(frames(flaky.ctx, flaky.session, { ...request, lens: 'fixture/retry' })).resolves.toEqual([{ kind: 'result', files: {} }])
    expect(mergeBase).toHaveBeenCalledTimes(2)
  })

  it('fails a file read the host refuses and refuses a change request whose status is not read', async () => {
    const opened = await bound()
    opened.provider.texts.set(`${HEAD}:src/a.ts`, { code: 'too-large', message: 'file over the contents limit' })
    await provideLens(opened.ctx, {
      id: 'fixture/new-only' as ForgeLensId,
      version: '1',
      classify: async (input) => {
        await input.text('new', 'src/a.ts', signal)
        return { files: {} }
      },
    })
    const { files } = await opened.ctx.forgePanel.changeRequestDiff(opened.session, pullUrl(7), null, signal)
    const request: ForgeLensRequest = { source: { kind: 'change', url: pullUrl(7), commits: null }, version: lensVersion(files), lens: 'fixture/new-only' }
    await expect(rejection(opened.ctx, opened.session, request))
      .resolves.toMatchObject({ code: 'forgePanel/lens-failed', message: 'the lens failed: file over the contents limit' })

    const unread = await open(await project())
    unread.provider.failures.set(9, { code: 'unavailable', message: 'down' })
    shellTurn(unread.session, 1, [{ callId: 'create', command: 'gh pr create --fill', output: `${pullUrl(9)}\n` }])
    const follower = follow(unread.ctx, unread.session)
    cleanups.push(follower.stop)
    await follower.until(state => state.changeRequests.some(entry => entry.update !== null))
    await provideLens(unread.ctx, exportsLens())
    await expect(rejection(unread.ctx, unread.session, { source: { kind: 'change', url: pullUrl(9), commits: null }, version: '', lens: 'fixture/exports' }))
      .resolves.toMatchObject({ code: 'forgePanel/lens-stale', message: 'The change request status has not been read yet' })
  })
})
