/** Real file tools preserve Review baselines without depending on git or model observations. */
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as captures from '../src/capture.ts'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, scratchDir, settle, startTurn } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const patch = (...operations: string[]) => ['*** Begin Patch', ...operations, '*** End Patch'].join('\n')
const add = (path: string) => `*** Add File: ${path}\n+created`
const update = (path: string, before = 'old', after = 'new') => `*** Update File: ${path}\n@@\n-${before}\n+${after}`
const remove = (path: string) => `*** Delete File: ${path}`
const move = (path: string, destination: string, before = 'old') =>
  `*** Update File: ${path}\n*** Move to: ${destination}\n@@\n-${before}\n+moved`

async function boot(environment: string) {
  const cwd = await realpath(await scratchDir('dsh-patch-review-', cleanups))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  if (environment === 'git-unavailable') {
    const resolve = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation((name, ...args) => {
      if (name === 'git') return Promise.reject(new Error('git unavailable in this fixture'))
      return resolve(name, ...args)
    })
  }
  provideWorkingDirectoryFixture(ctx, cwd)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs, { applyPatch: true })
  await ctx.plugin(WorkspaceChanges)
  const session = ctx.sessions.create(SessionId('patch-review'), { meta: { cwd } })
  const signal = new AbortController().signal
  let callNumber = 0
  let observations = 0
  ctx.on('fs/observed', () => { observations++ })
  async function execute(name: string, args: Record<string, string>) {
    const callId = ToolCallId(`patch-review-${++callNumber}`)
    const serialized = JSON.stringify(args)
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name, arguments: serialized }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    }, { surfaceOp: 'append' })
    const source = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: serialized })
    const result = await executeToolFixture(ctx, { signal, callId, name, arguments: args,
      // The fixture provides current-directory resolution for this Session.
      agent: { session } as never })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...result.meta === undefined ? {} : { meta: result.meta },
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    return result
  }
  const seed = (path: string, text = 'old\n') => writeFile(join(cwd, path), text)
  const read = async (path: string) => { expect((await execute('read', { file_path: path })).isError).toBe(false) }
  const apply = (text: string) => execute('apply_patch', { input: text })
  async function finish() {
    endTurn(session, 1)
    await settle(ctx, session)
    return changes(ctx, session)
  }
  async function diff(index: number) {
    const announcement = session.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)!
    return ctx.workspaceChanges.diff(session.id, announcement.seq, index, signal)
  }
  return { ctx, cwd, session, fs: ctx.fs as LocalFileSystem, seed, read, apply, finish, diff,
    observations: () => observations, bytes: (path: string) => readFile(join(cwd, path), 'utf8') }
}

/** Reconstruct these short fixtures from their full-context Review hunks. */
async function expectDiff(t: Awaited<ReturnType<typeof boot>>, index: number, before: string | null, after: string | null) {
  const diff = await t.diff(index)
  expect(diff).toMatchObject({ kind: 'text', before: before !== null, after: after !== null, coarse: false })
  if (diff?.kind !== 'text') throw new Error('expected a text comparison')
  const lines = diff.hunks.flatMap(hunk => hunk.lines)
  const text = (excluded: string) => lines.filter(line => !line.startsWith(excluded)).map(line => line.slice(1)).join('\n') + '\n'
  expect(before === null ? lines.filter(line => !line.startsWith('+')) : text('+')).toEqual(before ?? [])
  expect(after === null ? lines.filter(line => !line.startsWith('-')) : text('-')).toEqual(after ?? [])
}

describe.each(['non-git', 'git-unavailable'])('apply_patch Review in %s', (environment) => {
  it('captures add, update, delete and move as four net changed paths', async () => {
    const t = await boot(environment)
    await t.seed('source')
    await t.seed('gone', 'gone\n')
    startTurn(t.session, 1)
    await t.read('source')
    await t.read('gone')
    // Updating the same source that moves keeps all four operation kinds within four distinct paths.
    const result = await t.apply(patch(add('new'), update('source'), remove('gone'), move('source', 'nested/target', 'new')))
    expect(result.isError).toBe(false)
    const [summary] = await t.finish()
    expect(summary).toMatchObject({ total: 4, added: 2, deleted: 2 })
    expect(summary?.snapshot).toBeUndefined()
    expect(summary?.files).toEqual([
      { path: 'gone', display: 'gone', added: 0, deleted: 1 },
      { path: 'nested/target', display: 'nested/target', added: 1, deleted: 0 },
      { path: 'new', display: 'new', added: 1, deleted: 0 },
      { path: 'source', display: 'source', added: 0, deleted: 1 },
    ])
    await expectDiff(t, 0, 'gone\n', null)
    await expectDiff(t, 1, null, await t.bytes('nested/target'))
    await expectDiff(t, 2, null, await t.bytes('new'))
    await expectDiff(t, 3, 'old\n', null)
    await expect(t.bytes('source')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(t.bytes('gone')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the first baseline across two patches of one file', async () => {
    const t = await boot(environment)
    await t.seed('a')
    startTurn(t.session, 1)
    await t.read('a')
    expect((await t.apply(patch(update('a')))).isError).toBe(false)
    expect((await t.apply(patch(update('a', 'new', 'final')))).isError).toBe(false)
    const [summary] = await t.finish()
    expect(summary?.files).toEqual([{ path: 'a', display: 'a', added: 1, deleted: 1 }])
    await expectDiff(t, 0, 'old\n', await t.bytes('a'))
  })

  it('rejects an unread file without capture, observation, or a Review row', async () => {
    const t = await boot(environment)
    await t.seed('a')
    const capture = vi.spyOn(captures, 'captureFile')
    startTurn(t.session, 1)
    const result = await t.apply(patch(update('a')))
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_NOT_OBSERVED' } } })
    expect(capture).not.toHaveBeenCalled()
    expect(t.observations()).toBe(0)
    expect(await t.finish()).toEqual([])
    expect(await t.bytes('a')).toBe('old\n')
  })

  it('lists only op1 and the published move target after source removal fails', async () => {
    const t = await boot(environment)
    await t.seed('source')
    startTurn(t.session, 1)
    await t.read('source')
    t.fs.internals.removeFile = async () => { throw new FsError('source removal denied', 'FS_PERMISSION_DENIED') }
    const result = await t.apply(patch(add('first'), move('source', 'target'), add('skipped')))
    expect(result).toMatchObject({ isError: false, value: { phase: 'commit', operations: [
      { status: 'completed' }, { status: 'failed' }, { status: 'skipped' },
    ] } })
    const [summary] = await t.finish()
    expect(summary?.files).toEqual([
      { path: 'first', display: 'first', added: 1, deleted: 0 },
      { path: 'target', display: 'target', added: 1, deleted: 0 },
    ])
    await expectDiff(t, 0, null, await t.bytes('first'))
    await expectDiff(t, 1, null, await t.bytes('target'))
    expect(await t.bytes('source')).toBe('old\n')
    await expect(t.bytes('skipped')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('omits files created then deleted and edited then restored within one turn', async () => {
    const t = await boot(environment)
    await t.seed('a')
    startTurn(t.session, 1)
    await t.read('a')
    expect((await t.apply(patch(add('temporary'), update('a')))).isError).toBe(false)
    expect((await t.apply(patch(remove('temporary'), update('a', 'new', 'old')))).isError).toBe(false)
    expect(await t.finish()).toEqual([])
    expect(await t.bytes('a')).toBe('old\n')
    await expect(t.bytes('temporary')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finishes both move captures before provider publication without adding observations', async () => {
    const t = await boot(environment)
    await t.seed('source')
    startTurn(t.session, 1)
    await t.read('source')
    const observed = t.observations()
    const completed: Array<{ path: string; capture: captures.Capture | undefined }> = []
    const capture = captures.captureFile
    vi.spyOn(captures, 'captureFile').mockImplementation(async (...args) => {
      const value = await capture(...args)
      completed.push({ path: args[0], capture: value })
      return value
    })
    const inspect = vi.fn(async () => {
      expect(completed.map(item => item.path)).toEqual([join(t.cwd, 'source'), join(t.cwd, 'new-parent/target')])
      expect(completed[0]?.capture).toMatchObject({ kind: 'file' })
      expect(completed[1]?.capture).toEqual({ kind: 'absent' })
      expect(t.observations()).toBe(observed)
      expect(await t.bytes('source')).toBe('old\n')
      await expect(t.bytes('new-parent/target')).rejects.toMatchObject({ code: 'ENOENT' })
    })
    t.fs.internals.inspectTemp = inspect
    expect((await t.apply(patch(move('source', 'new-parent/target')))).isError).toBe(false)
    expect(inspect).toHaveBeenCalledOnce()
    const [summary] = await t.finish()
    expect(summary?.files.map(file => file.path)).toEqual(['new-parent/target', 'source'])
    await expectDiff(t, 0, null, 'moved\n')
    await expectDiff(t, 1, 'old\n', null)
  })

  it('rejects invalid syntax without capturing or recording paths', async () => {
    const t = await boot(environment)
    const capture = vi.spyOn(captures, 'captureFile')
    startTurn(t.session, 1)
    expect(await t.apply('invalid')).toMatchObject({ isError: true, error: { info: { code: 'PATCH_SYNTAX' } } })
    expect(await t.finish()).toEqual([])
    expect(capture).not.toHaveBeenCalled()
    expect(t.observations()).toBe(0)
  })

  it('coalesces ./a and a into the same baseline and Review row', async () => {
    const t = await boot(environment)
    await t.seed('a')
    startTurn(t.session, 1)
    await t.read('a')
    expect((await t.apply(patch(update('./a')))).isError).toBe(false)
    expect((await t.apply(patch(update('a', 'new', 'final')))).isError).toBe(false)
    const [summary] = await t.finish()
    expect(summary?.files).toEqual([{ path: 'a', display: 'a', added: 1, deleted: 1 }])
    await expectDiff(t, 0, 'old\n', 'final\n')
  })
})
