/** The plugin records each top-level turn's file changes from real git snapshots and whole-file captures, and serves their comparisons. */
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, git, mutate, scratchDir, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

const signal = new AbortController().signal

async function boot(config: Partial<WorkspaceChanges.Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(WorkspaceChanges, config as WorkspaceChanges.Config)
  return { ctx, fiber }
}

/** Loose objects the repository itself holds. */
function looseObjects(cwd: string): number {
  return Number(git(cwd, 'count-objects').split(' ')[0])
}

async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-workspace-changes-repo-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  await writeFile(join(cwd, 'b.txt'), 'x\n')
  await writeFile(join(cwd, 'same.txt'), 'same\n')
  await writeFile(join(cwd, '.gitignore'), '.env*\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

/** The sequence of the latest announcement for one session. */
function announcedSeq(session: Session): number {
  const event = session.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)
  if (event === undefined) throw new Error('no workspace/changes announcement')
  return event.seq
}

describe('workspace-changes in a repository', () => {
  it('records the turn’s own changes and excludes the user’s prior uncommitted work', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'b.txt'), 'x user\n')
    await writeFile(join(cwd, 'u.txt'), 'user untracked\n')
    const { ctx } = await boot()
    const repositoryObjects = looseObjects(cwd)
    const session = ctx.sessions.create(SessionId('repo'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)

    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l2', new_string: 'l2 model' },
      () => writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\nl4\n'), { meta: { diffs: [{ path: 'a.txt', oldText: 'l2', newText: 'l2 model' }] } })
    await mkdir(join(cwd, 'sub', 'dir'), { recursive: true })
    await writeFile(join(cwd, 'sub', 'dir', 'c.txt'), 'c\n')
    await writeFile(join(cwd, 'new.txt'), 'n1\nn2\n')
    await writeFile(join(cwd, 'bin.dat'), Uint8Array.of(0, 1, 2, 255))
    toolCall(session, 1, 'bash', { command: 'printf > files' })
    // An ignored file is captured before its first edit and read again at turn end; repeated edits count once.
    await mutate(ctx, session, 1, 'write', { file_path: '.env', content: 'A=1\n' }, () => writeFile(join(cwd, '.env'), 'A=1\n'))
    await mutate(ctx, session, 1, 'edit', { file_path: '.env', old_string: 'A=1', new_string: 'A=1\nB=2' }, () => writeFile(join(cwd, '.env'), 'A=1\nB=2\n'))
    await mutate(ctx, session, 1, 'write', { file_path: join(tmpdir(), 'scratch.txt'), content: 'scratch\n' }, () => Promise.resolve())
    await mutate(ctx, session, 1, 'write', { file_path: 'failed.txt', content: 'x' }, () => Promise.resolve(), { isError: true })
    // A created ignored file that is gone again by turn end is not a change.
    await mutate(ctx, session, 1, 'str_replace_editor', { command: 'create', path: '.env.gone', file_text: 'x' }, () => Promise.resolve())
    await mutate(ctx, session, 1, 'edit', { file_path: 'same.txt', old_string: 'same', new_string: 'same' }, () => Promise.resolve())
    toolCall(session, 2, 'write', { file_path: 'other-turn' }, { meta: { diffs: [{ path: 'other.txt', oldText: null, newText: 'x' }] } })
    endTurn(session, 1)
    await settle(ctx, session)

    const events = session.snapshotEvents().filter(event => event.type === 'workspace/changes')
    expect(events.map(event => event.data)).toEqual([{ turn: 1 }])
    const [recorded, ...rest] = changes(ctx, session)
    expect(rest).toEqual([])
    expect(recorded).toMatchObject({ turn: 1, cwd, total: 5, added: 7, deleted: 1 })
    expect(recorded!.snapshot!.before).toMatch(/^[0-9a-f]{40,64}$/)
    expect(recorded!.snapshot!.after).toMatch(/^[0-9a-f]{40,64}$/)
    expect(recorded!.files).toEqual([
      { path: '.env', display: '.env', added: 2, deleted: 0 },
      { path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 },
      { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
      { path: 'new.txt', display: 'new.txt', added: 2, deleted: 0 },
      { path: 'sub/dir/c.txt', display: 'sub/dir/c.txt', added: 1, deleted: 0 },
    ])
    expect(git(cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M a.txt', ' M b.txt', '?? bin.dat', '?? new.txt', '?? sub/', '?? u.txt',
    ])
    // Snapshot objects live in the recorder's temporary directory; the repository's own store is untouched.
    expect(looseObjects(cwd)).toBe(repositoryObjects)
    // Summaries are served by session and event sequence only while the Session lives.
    const seq = events[0]!.seq
    expect(ctx.workspaceChanges.summary(session.id, seq)).toBe(recorded)
    expect(ctx.workspaceChanges.summary(session.id, seq + 1)).toBeUndefined()
    expect(ctx.workspaceChanges.summary(SessionId('elsewhere'), seq)).toBeUndefined()
    ctx.emit('session/disposed', session)
    expect(ctx.workspaceChanges.summary(session.id, seq)).toBeUndefined()
  })

  it('serves each listed file’s comparison from the snapshots or the captured copies', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'long.txt'), `${'0123456789'.repeat(10)}\n`)
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'long')
    const { ctx } = await boot({ maxFileBytes: 64 })
    const session = ctx.sessions.create(SessionId('compare'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(cwd, 'a.txt'), 'l1\nl2 model\nl3\n')
    await writeFile(join(cwd, 'new.txt'), 'n1\n')
    await rm(join(cwd, 'b.txt'))
    await rename(join(cwd, 'same.txt'), join(cwd, 'moved.txt'))
    await writeFile(join(cwd, 'long.txt'), `${'0123456789'.repeat(10)}\nmore\n`)
    await writeFile(join(cwd, 'bin.dat'), Uint8Array.of(0, 1, 2, 255))
    toolCall(session, 1, 'bash', { command: 'x' })
    await mutate(ctx, session, 1, 'write', { file_path: '.env', content: 'A=1\nB=2\n' }, () => writeFile(join(cwd, '.env'), 'A=1\nB=2\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    const seq = announcedSeq(session)
    const [recorded] = changes(ctx, session)
    expect(recorded!.files.map(file => file.display)).toEqual(['.env', 'a.txt', 'b.txt', 'bin.dat', 'long.txt', 'moved.txt', 'new.txt'])
    const diff = (index: number) => ctx.workspaceChanges.diff(session.id, seq, index, signal)
    expect(await diff(0)).toEqual({
      kind: 'text', path: '.env', display: '.env', before: false, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+A=1', '+B=2'] }],
    })
    expect(await diff(1)).toEqual({
      kind: 'text', path: 'a.txt', display: 'a.txt', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' l1', '-l2', '+l2 model', ' l3'] }],
    })
    expect(await diff(2)).toMatchObject({ kind: 'text', path: 'b.txt', before: true, after: false, hunks: [{ lines: ['-x'] }] })
    expect(await diff(3)).toEqual({ kind: 'binary', path: 'bin.dat', display: 'bin.dat' })
    // A snapshot blob beyond the byte cap keeps its git counts but serves no lines.
    expect(recorded!.files[4]).toMatchObject({ path: 'long.txt', added: 1, deleted: 0 })
    expect(await diff(4)).toEqual({ kind: 'oversized', path: 'long.txt', display: 'long.txt' })
    // A rename compares the old path's turn-start content with the new path's turn-end content.
    expect(await diff(5)).toEqual({ kind: 'text', path: 'moved.txt', display: 'moved.txt', before: true, after: true, coarse: false, hunks: [] })
    expect(await diff(6)).toMatchObject({ kind: 'text', path: 'new.txt', before: false, after: true, hunks: [{ lines: ['+n1'] }] })
    expect(await diff(7)).toBeUndefined()
    expect(await ctx.workspaceChanges.diff(session.id, seq + 1, 0, signal)).toBeUndefined()
    expect(await ctx.workspaceChanges.diff(SessionId('elsewhere'), seq, 0, signal)).toBeUndefined()
    // A caller's abort fails the read while the Session lives; disposal under a running read answers undefined.
    const aborted = AbortSignal.abort()
    await expect(ctx.workspaceChanges.diff(session.id, seq, 0, aborted)).rejects.toThrow()
    await expect(ctx.workspaceChanges.diff(session.id, seq, 1, aborted)).rejects.toThrow('aborted')
    const pending = ctx.workspaceChanges.diff(session.id, seq, 1, signal)
    ctx.emit('session/disposed', session)
    expect(await pending).toBeUndefined()
    expect(await diff(0)).toBeUndefined()
  })

  it('records nothing and stays quiet about captures for a working directory that no longer exists', async () => {
    const root = await scratchDir('dsh-workspace-changes-gone-', cleanups)
    const cwd = join(root, 'gone')
    const { ctx } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('gone'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'w.txt', content: 'w\n' }, () => Promise.resolve())
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session)).toEqual([])
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith('workspace-changes:'))).toHaveLength(1)
  })

  it('places files above the working directory and outside the repository by their display rule', async () => {
    const root = await repository()
    const cwd = join(root, 'pkg')
    await mkdir(cwd)
    const outside = await mkdtemp(join(homedir(), '.dsh-workspace-changes-test-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('nested'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(root, 'a.txt'), 'changed\n')
    await writeFile(join(cwd, 'inner.txt'), 'inner\n')
    await mutate(ctx, session, 1, 'str_replace_editor', { command: 'insert', path: join(outside, 'note.txt'), insert_line: 0, new_str: 'one\ntwo\nthree\n' },
      () => writeFile(join(outside, 'note.txt'), 'one\ntwo\nthree\n'))
    endTurn(session, 1, 'blocked')
    await settle(ctx, session)
    const [recorded] = changes(ctx, session)
    expect(recorded!.files).toEqual([
      { path: join(await realpath(root), 'a.txt'), display: '../a.txt', added: 1, deleted: 3 },
      { path: 'inner.txt', display: 'inner.txt', added: 1, deleted: 0 },
      { path: join(await realpath(outside), 'note.txt'), display: `~/${outside.slice(homedir().length + 1)}/note.txt`, added: 3, deleted: 0 },
    ])
    expect(await ctx.workspaceChanges.diff(session.id, announcedSeq(session), 2, signal)).toMatchObject({ kind: 'text', before: false, after: true, hunks: [{ lines: ['+one', '+two', '+three'] }] })
  })

  it('records inside the turn when the agent stops, and again after turn/end only when tools settled later', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('stopping'), { meta: { cwd } })
    const agent = { session } as never
    startTurn(session, 1)
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal })
    expect(changes(ctx, session)).toEqual([])
    await writeFile(join(cwd, 'one.txt'), '1\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    await ctx.serial('agent/turn-stopping', { agent, turn: 7, signal })
    await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal })
    const inTurn = session.snapshotEvents().find(event => event.type === 'workspace/changes')
    expect(ctx.workspaceChanges.summary(session.id, inTurn!.seq)).toMatchObject({ turn: 1, total: 1 })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session)).toHaveLength(1)
    expect(session.snapshotEvents().find(event => event.type === 'turn/end')!.seq).toBeGreaterThan(inTurn!.seq)

    startTurn(session, 2)
    await settle(ctx, session)
    await writeFile(join(cwd, 'two.txt'), '2\n')
    toolCall(session, 2, 'bash', { command: 'x' })
    await ctx.serial('agent/turn-stopping', { agent, turn: 2, signal })
    await rm(join(cwd, 'two.txt'))
    toolCall(session, 2, 'bash', { command: 'steered' })
    endTurn(session, 2)
    await settle(ctx, session)
    const second = changes(ctx, session).filter(data => data.turn === 2)
    expect(second.map(data => data.files.map(file => file.path))).toEqual([['two.txt'], []])
    expect(second[1]).toMatchObject({ total: 0 })

    startTurn(session, 3)
    await settle(ctx, session)
    toolCall(session, 3, 'read', { file_path: 'a.txt' })
    endTurn(session, 3)
    await settle(ctx, session)
    expect(changes(ctx, session).filter(data => data.turn === 3)).toEqual([])
  })

  it('keeps an interrupted turn’s record when the next turn starts before it settles', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('interleaved'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(cwd, 'one.txt'), '1\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    endTurn(session, 1, 'blocked')
    startTurn(session, 2)
    await settle(ctx, session)
    await writeFile(join(cwd, 'two.txt'), '2\n')
    toolCall(session, 2, 'bash', { command: 'x' })
    endTurn(session, 2)
    await settle(ctx, session)
    expect(changes(ctx, session).map(data => [data.turn, data.files.map(file => file.display)])).toEqual([[1, ['one.txt']], [2, ['two.txt']]])
  })

  it('caps the file list while reporting the complete count', async () => {
    const cwd = await repository()
    const { ctx } = await boot({ maxFiles: 2 })
    const session = ctx.sessions.create(SessionId('capped'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    for (const name of ['c.txt', 'd.txt', 'e.txt']) await writeFile(join(cwd, name), `${name}\n`)
    toolCall(session, 1, 'bash', { command: 'x' })
    await mutate(ctx, session, 1, 'edit', { file_path: 'a.txt', old_string: 'l1', new_string: 'l1' }, () => Promise.resolve())
    endTurn(session, 1)
    await settle(ctx, session)
    const [recorded] = changes(ctx, session)
    expect(recorded!.total).toBe(3)
    expect(recorded!.files.map(file => file.display)).toEqual(['c.txt', 'd.txt'])
    expect(await ctx.workspaceChanges.diff(session.id, announcedSeq(session), 2, signal)).toBeUndefined()
  })

  it('warns and skips the turn when its git work fails', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(join(cwd, 'missing-git'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('warn'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(cwd, 'x.txt'), 'x\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    // A repository whose snapshot failed is not summarized from captures as if it had no repository.
    await mutate(ctx, session, 1, 'write', { file_path: 'y.txt', content: 'y\n' }, () => writeFile(join(cwd, 'y.txt'), 'y\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session)).toEqual([])
    const own = warn.mock.calls.map(call => String(call[0])).filter(message => message.startsWith('workspace-changes:'))
    expect(own).toHaveLength(1)
    expect(own[0]).toContain('missing-git')
  })

  it('leaves nested repositories out even when a file tool edits inside them', async () => {
    const cwd = await repository()
    const sub = join(cwd, 'sub')
    await mkdir(sub)
    git(sub, 'init', '-q', '-b', 'main')
    await writeFile(join(sub, 'inner.txt'), 'inner\n')
    git(sub, 'add', '-A'); git(sub, 'commit', '-q', '-m', 'inner')
    git(cwd, 'add', 'sub'); git(cwd, 'commit', '-q', '-m', 'gitlink')
    const { ctx } = await boot()
    const session = ctx.sessions.create(SessionId('gitlink'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'edit', { file_path: 'sub/inner.txt', old_string: 'inner', new_string: 'inner\nedited' },
      () => writeFile(join(sub, 'inner.txt'), 'inner\nedited\n'))
    await mutate(ctx, session, 1, 'write', { file_path: 'top.txt', content: 'top\n' }, () => writeFile(join(cwd, 'top.txt'), 'top\n'))
    await mutate(ctx, session, 1, 'write', { file_path: 'same.txt', content: 'same\n' }, () => writeFile(join(cwd, 'same.txt'), 'same\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session).map(summary => summary.files.map(file => file.display))).toEqual([['top.txt']])
  })

  it('rejects non-positive bounds at load', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.plugin(WorkspaceChanges, { maxFiles: 0 } as WorkspaceChanges.Config)).rejects.toThrow('positive integer maxFiles')
    await expect(ctx.plugin(WorkspaceChanges, { diffTimeoutMs: 1.5 } as WorkspaceChanges.Config)).rejects.toThrow('positive integer diffTimeoutMs')
  })
})

describe('workspace-changes without a repository', () => {
  it('summarizes file-tool edits only for a working directory outside any git repository', async () => {
    const cwd = await scratchDir('dsh-workspace-changes-plain-', cleanups)
    await writeFile(join(cwd, 'existing.txt'), 'before\n')
    await writeFile(join(cwd, 'shell.txt'), 'shell\n')
    const outside = await mkdtemp(join(homedir(), '.dsh-workspace-changes-plain-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const { ctx } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('plain'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'existing.txt', content: 'after\nmore\n' }, () => writeFile(join(cwd, 'existing.txt'), 'after\nmore\n'))
    await mutate(ctx, session, 1, 'edit', { file_path: 'existing.txt', old_string: 'more', new_string: 'more\nagain' }, () => writeFile(join(cwd, 'existing.txt'), 'after\nmore\nagain\n'))
    // Shell edits and scratch files under a temporary root stay out; a file elsewhere outside the workspace counts.
    await writeFile(join(cwd, 'shell.txt'), 'shell\nedited\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    await mutate(ctx, session, 1, 'write', { file_path: join(tmpdir(), 'scratch.txt'), content: 'scratch\n' }, () => Promise.resolve())
    await mutate(ctx, session, 1, 'str_replace_editor', { command: 'create', path: join(outside, 'note.txt'), file_text: 'one\ntwo\n' },
      () => writeFile(join(outside, 'note.txt'), 'one\ntwo\n'))
    // A file the shell edits after a file tool touched it is compared by its final content.
    await mutate(ctx, session, 1, 'write', { file_path: 'mixed.txt', content: 'tool\n' }, () => writeFile(join(cwd, 'mixed.txt'), 'tool\n'))
    await writeFile(join(cwd, 'mixed.txt'), 'tool\nshell\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session)).toEqual([{
      turn: 1, cwd, total: 3, added: 7, deleted: 1,
      files: [
        { path: 'existing.txt', display: 'existing.txt', added: 3, deleted: 1 },
        { path: 'mixed.txt', display: 'mixed.txt', added: 2, deleted: 0 },
        { path: join(await realpath(outside), 'note.txt'), display: `~/${outside.slice(homedir().length + 1)}/note.txt`, added: 2, deleted: 0 },
      ],
    }])
    const seq = announcedSeq(session)
    expect(await ctx.workspaceChanges.diff(session.id, seq, 0, signal)).toEqual({
      kind: 'text', path: 'existing.txt', display: 'existing.txt', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ['-before', '+after', '+more', '+again'] }],
    })
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith('workspace-changes:'))).toEqual([])
    await expect(stat(join(cwd, '.git'))).rejects.toThrow()
  })

  it('lists oversized and binary captured files without counts and serves no lines for them', async () => {
    const cwd = await scratchDir('dsh-workspace-changes-bounds-', cleanups)
    // The recorder places its temporary directory under the platform temp root; point that root at a scratch directory.
    const tempRoot = await scratchDir('dsh-workspace-changes-temp-', cleanups)
    // POSIX reads TMPDIR, Windows reads TMP then TEMP.
    const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    for (const name of ['TMPDIR', 'TMP', 'TEMP'] as const) process.env[name] = tempRoot
    cleanups.push(async () => {
      for (const name of ['TMPDIR', 'TMP', 'TEMP'] as const) {
        if (previous[name] === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = previous[name]
      }
    })
    // Other tooling may create its own directories under the redirected temp root; only the recorder's count.
    const recorderDirs = async (): Promise<string[]> => (await readdir(tempRoot)).filter(name => name.startsWith('dsh-workspace-changes-'))
    await writeFile(join(cwd, 'grows.txt'), 'small\n')
    await writeFile(join(cwd, 'huge.txt'), 'a'.repeat(20))
    await writeFile(join(cwd, 'mixed.dat'), Uint8Array.of(65, 0, 66))
    await mkdir(join(cwd, 'already-dir'))
    const { ctx } = await boot({ maxFileBytes: 16 })
    const session = ctx.sessions.create(SessionId('bounds'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await mutate(ctx, session, 1, 'write', { file_path: 'grows.txt', content: 'x' }, () => writeFile(join(cwd, 'grows.txt'), 'x'.repeat(17)))
    // Both sides beyond the cap are never known to match, so the file is listed rather than dropped.
    await mutate(ctx, session, 1, 'write', { file_path: 'huge.txt', content: 'b' }, () => writeFile(join(cwd, 'huge.txt'), 'b'.repeat(20)))
    // An oversized side outranks a binary one in the card and the tab alike.
    await mutate(ctx, session, 1, 'write', { file_path: 'mixed.dat', content: 'x' }, () => writeFile(join(cwd, 'mixed.dat'), 'x'.repeat(17)))
    await mutate(ctx, session, 1, 'write', { file_path: 'shrinks.txt', content: 'x' }, () => writeFile(join(cwd, 'shrinks.txt'), 'x'))
    await mutate(ctx, session, 1, 'write', { file_path: 'bin.dat', content: 'x' }, () => writeFile(join(cwd, 'bin.dat'), Uint8Array.of(65, 0, 66)))
    // A directory at the path, before or after the call, is neither absent nor a file, so the path is not tracked.
    await mutate(ctx, session, 1, 'write', { file_path: 'dir', content: 'x' }, () => mkdir(join(cwd, 'dir')))
    await mutate(ctx, session, 1, 'write', { file_path: 'already-dir', content: 'x' }, () => Promise.resolve())
    endTurn(session, 1)
    await settle(ctx, session)
    const [recorded] = changes(ctx, session)
    expect(recorded!.files).toEqual([
      { path: 'bin.dat', display: 'bin.dat', added: 0, deleted: 0, binary: true },
      { path: 'grows.txt', display: 'grows.txt', added: 0, deleted: 0, oversized: true },
      { path: 'huge.txt', display: 'huge.txt', added: 0, deleted: 0, oversized: true },
      { path: 'mixed.dat', display: 'mixed.dat', added: 0, deleted: 0, oversized: true },
      { path: 'shrinks.txt', display: 'shrinks.txt', added: 1, deleted: 0 },
    ])
    const seq = announcedSeq(session)
    expect(await ctx.workspaceChanges.diff(session.id, seq, 0, signal)).toEqual({ kind: 'binary', path: 'bin.dat', display: 'bin.dat' })
    for (const index of [1, 2, 3]) {
      expect(await ctx.workspaceChanges.diff(session.id, seq, index, signal)).toMatchObject({ kind: 'oversized', path: recorded!.files[index]!.path })
    }
    expect(await ctx.workspaceChanges.diff(session.id, seq, 4, signal)).toMatchObject({ kind: 'text', before: false, after: true, hunks: [{ lines: ['+x'] }] })
    // Every copy lives under the Session's temporary directory and goes with it.
    const [scratch, ...others] = await recorderDirs()
    expect(others).toEqual([])
    expect(scratch).toBeDefined()
    expect((await readdir(join(tempRoot, scratch as string, 'captures'))).length).toBeGreaterThan(0)
    ctx.emit('session/disposed', session)
    await vi.waitFor(async () => { expect(await recorderDirs()).toEqual([]) })
  })

  it('drops a disposed session’s recorder and starts afresh on its next turn', async () => {
    const cwd = await repository()
    const { ctx, fiber } = await boot()
    const session = ctx.sessions.create(SessionId('disposed'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    ctx.emit('session/disposed', session)
    await writeFile(join(cwd, 'one.txt'), '1\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session)).toEqual([])
    startTurn(session, 2)
    await settle(ctx, session)
    await writeFile(join(cwd, 'two.txt'), '2\n')
    toolCall(session, 2, 'bash', { command: 'x' })
    endTurn(session, 2)
    await settle(ctx, session)
    expect(changes(ctx, session).map(data => data.files.map(file => file.display))).toEqual([['two.txt']])

    startTurn(session, 3)
    await settle(ctx, session)
    await fiber.dispose()
    await writeFile(join(cwd, 'three.txt'), '3\n')
    toolCall(session, 3, 'bash', { command: 'x' })
    endTurn(session, 3)
    await settle(ctx, session)
    expect(session.snapshotEvents().filter(event => event.type === 'workspace/changes' && event.data.turn === 3)).toEqual([])
  })

  it('ignores subagent sessions and sessions without a working directory', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    const sessions = [
      ctx.sessions.create(SessionId('child'), { meta: { cwd, delegationDepth: 1 } }),
      ctx.sessions.create(SessionId('origin'), { meta: { cwd, origin: 'subagent' } }),
      ctx.sessions.create(SessionId('nowhere')),
    ]
    for (const session of sessions) {
      startTurn(session, 1)
      await settle(ctx, session)
      await mutate(ctx, session, 1, 'write', { file_path: 'w.txt', content: 'w\n' }, () => writeFile(join(cwd, 'w.txt'), 'w\n'))
      endTurn(session, 1)
      await settle(ctx, session)
      expect(changes(ctx, session)).toEqual([])
      await rm(join(cwd, 'w.txt'))
    }
    await ctx.waterfall('tools/pre-execute', {} as never, () => Promise.resolve(undefined as never))
  })
})

describe('workspace-changes without git', () => {
  it('summarizes file-tool edits only, even inside a repository, and reports the absence once', async () => {
    const cwd = await repository()
    const { ctx } = await boot()
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockRejectedValue(new Error('git: not found'))
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('nogit'), { meta: { cwd } })
    for (const turn of [1, 2]) {
      startTurn(session, turn)
      await settle(ctx, session)
      await writeFile(join(cwd, `${turn}.txt`), 'x\n')
      toolCall(session, turn, 'bash', { command: 'x' })
      if (turn === 2) await mutate(ctx, session, turn, 'write', { file_path: 'w.txt', content: 'w\n' }, () => writeFile(join(cwd, 'w.txt'), 'w\n'))
      endTurn(session, turn)
      await settle(ctx, session)
    }
    expect(changes(ctx, session)).toEqual([{ turn: 2, cwd, total: 1, added: 1, deleted: 0, files: [{ path: 'w.txt', display: 'w.txt', added: 1, deleted: 0 }] }])
    expect(await ctx.workspaceChanges.diff(session.id, announcedSeq(session), 0, signal)).toMatchObject({ kind: 'text', before: false, after: true, hunks: [{ lines: ['+w'] }] })
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![0]).toContain('git is unavailable')
  })

  it('treats the macOS developer-tools stub as absent until a developer directory is selected', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    cleanups.push(async () => { Object.defineProperty(process, 'platform', platform) })
    const probes: Array<{ done: Promise<{ exitCode: number | null; signal: null }>; available: boolean; executable?: string }> = [
      { done: Promise.reject(new Error('spawn failed')), available: false },
      { done: Promise.resolve({ exitCode: 1, signal: null }), available: false },
      { done: Promise.resolve({ exitCode: 0, signal: null }), available: true },
      { done: Promise.resolve({ exitCode: 1, signal: null }), available: true, executable: '/opt/homebrew/bin/git' },
    ]
    for (const probe of probes) {
      probe.done.catch(() => undefined)
      const cwd = await scratchDir('dsh-workspace-changes-stub-', cleanups)
      const { ctx } = await boot()
      vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(probe.executable ?? '/usr/bin/git')
      const real = ctx.subprocess.spawn.bind(ctx.subprocess)
      const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec =>
        spec.argv[0] === '/usr/bin/xcode-select' ? { done: probe.done } as never : real(spec))
      const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      const session = ctx.sessions.create(SessionId('stub'), { meta: { cwd } })
      startTurn(session, 1)
      await settle(ctx, session)
      expect(spawn.mock.calls.some(call => call[0].argv[0] === '/usr/bin/xcode-select')).toBe(probe.executable === undefined)
      expect(info).toHaveBeenCalledTimes(probe.available ? 0 : 1)
      await ctx.fiber.dispose()
    }
  })
})
