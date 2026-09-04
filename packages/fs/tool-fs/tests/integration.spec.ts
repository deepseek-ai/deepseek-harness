/**
 * End-to-end tool-registry tests against the real local backend. The policy deployment verifies
 * observed-state and guarded mutation; the bare deployment proves unconditional tools have no
 * policy-service dependency. Assertions read files back byte-for-byte rather than trusting tool
 * messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
// No header cwd: sessionCwd returns undefined and the provider's configured test dir applies.
const session = { header: {} }

let callCounter = 0
function call(name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

function notObservedDiagnostic(path: string): string {
  return `Error: cannot modify "${path}": file has not been read — read the file, then retry`
}

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

// --------------------------------------------------------------------------
// DEFAULT deployment: the policy gate plugin is loaded.
// --------------------------------------------------------------------------
describe('default deployment (with dsh-fs-observation-policy)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(ToolFs)
  })

  describe('write → disk', () => {
    it('creates a file with exactly the requested bytes', async () => {
      const result = await call('write', { file_path: 'new.txt', content: 'line one\nline two\n' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('line one\nline two\n')
    })

    it('rejects overwriting an existing file without reading it first', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      const result = await call('write', { file_path: 'a.txt', content: 'clobber' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
      expect(text(result)).toBe(notObservedDiagnostic(join(dir, 'a.txt')))
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original')
    })

    it('allows overwriting after a read', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      expect((await call('read', { file_path: 'a.txt' })).isError).toBe(false)
      const result = await call('write', { file_path: 'a.txt', content: 'replaced' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('replaced')
    })

    it('rejects a full overwrite when the file changed since the read (stale)', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      await call('read', { file_path: 'a.txt' })
      await writeFile(join(dir, 'a.txt'), 'changed-externally') // out-of-band change
      const result = await call('write', { file_path: 'a.txt', content: 'replaced' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
      // The model-facing text names the remedy, not just the condition.
      expect(text(result)).toContain('file changed since it was read')
      expect(text(result)).toContain('re-read the file, then retry')
    })

    it('the stale remedy is actionable: re-reading the changed file unblocks the retried write', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      await call('read', { file_path: 'a.txt' })
      await writeFile(join(dir, 'a.txt'), 'changed-externally') // out-of-band change
      const stale = await call('write', { file_path: 'a.txt', content: 'replaced' })
      expect(stale.isError).toBe(true)
      expect(stale.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
      // Follow the remedy: re-read (refreshes the observed version), then retry.
      expect((await call('read', { file_path: 'a.txt' })).isError).toBe(false)
      const retried = await call('write', { file_path: 'a.txt', content: 'replaced' })
      expect(retried.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('replaced')
    })
  })

  describe('read', () => {
    it('returns line-numbered content', async () => {
      await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
      const result = await call('read', { file_path: 'a.txt' })
      expect(text(result)).toContain('1: alpha')
      expect(text(result)).toContain('2: beta')
      expect(text(result)).toContain('(End of file - total 2 lines)')
    })

    it('reports a binary file as an error', async () => {
      await writeFile(join(dir, 'bin'), Buffer.from([0x00, 0x01, 0x02]))
      const result = await call('read', { file_path: 'bin' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_NOT_TEXT' } })
    })

    it('paginates a multi-line file with offset/limit', async () => {
      await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour')
      const result = await call('read', { file_path: 'a.txt', offset: 2, limit: 2 })
      expect(text(result)).toContain('2: two')
      expect(text(result)).toContain('3: three')
      expect(text(result)).toContain('(Showing lines 2-3 of 4. Use offset=4 to continue.)')
    })
  })

  describe('edit → disk', () => {
    it('applies a unique literal replacement after a read', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      await call('read', { file_path: 'a.txt' })
      const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
    })

    it('rejects an edit before any read, leaving the file untouched', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
      expect(text(result)).toBe(notObservedDiagnostic(join(dir, 'a.txt')))
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello world')
    })

    it('lets a WINDOWED read authorize an edit when the file is unchanged (freshness, not full-view)', async () => {
      // A file with more lines than the read window; read only the first line.
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      await writeFile(join(dir, 'a.txt'), lines.join('\n'))
      const read = await call('read', { file_path: 'a.txt', offset: 1, limit: 1 })
      expect(read.isError).toBe(false)
      expect(text(read)).toContain('(Showing lines 1-1 of 20')

      // Editing a line OUTSIDE the window is authorized because the file is unchanged.
      const result = await call('edit', { file_path: 'a.txt', old_string: 'line 12', new_string: 'LINE 12' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe(lines.map(l => l === 'line 12' ? 'LINE 12' : l).join('\n'))
    })

    it('rejects an edit when the file changed since the windowed read (stale before matching)', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      await call('read', { file_path: 'a.txt', offset: 1, limit: 1 })
      await writeFile(join(dir, 'a.txt'), 'goodbye') // out-of-band change removes 'world'
      const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
      // The model-facing text names the remedy, not just the condition.
      expect(text(result)).toContain('file changed since it was read')
      expect(text(result)).toContain('re-read the file, then retry')
    })

    it('the stale remedy is actionable: re-reading the changed file unblocks the retried edit', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      await call('read', { file_path: 'a.txt' })
      await writeFile(join(dir, 'a.txt'), 'hello brave world') // out-of-band change
      const stale = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(stale.isError).toBe(true)
      expect(stale.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
      // Follow the remedy: re-read (refreshes the observed version), then retry.
      expect((await call('read', { file_path: 'a.txt' })).isError).toBe(false)
      const retried = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(retried.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello brave there')
    })

    it('rejects an ambiguous match without replace_all', async () => {
      await writeFile(join(dir, 'a.txt'), 'a a a')
      await call('read', { file_path: 'a.txt' })
      const result = await call('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_AMBIGUOUS_EDIT' } })
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a a a')
    })

    it('replaces all matches with replace_all', async () => {
      await writeFile(join(dir, 'a.txt'), 'a a a')
      await call('read', { file_path: 'a.txt' })
      const result = await call('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('b b b')
    })

    it('supports a full write→edit cycle without an intervening read', async () => {
      await call('write', { file_path: 'a.txt', content: 'one two' })
      const result = await call('edit', { file_path: 'a.txt', old_string: 'two', new_string: 'three' })
      expect(result.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one three')
    })
  })

  describe('the gate records only through the events (no method coupling)', () => {
    it('a direct ctx.fs.readText records no observed-state, so a later edit rejects', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      // Reach AROUND the tool — an explicit escape hatch for non-tool consumers.
      await ctx.fs.readText(await ctx.fs.resolve('a.txt'))
      // The model-facing edit still rejects: the read did not emit fs/observed.
      const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_NOT_OBSERVED' } })
    })
  })

  describe('deleted observed target', () => {
    it('a failed reread records absence so write can safely recreate the file', async () => {
      await writeFile(join(dir, 'a.txt'), 'original')
      await call('read', { file_path: 'a.txt' })
      await rm(join(dir, 'a.txt')) // out-of-band deletion

      // The original positive observation still protects the first mutation.
      const edit = await call('edit', { file_path: 'a.txt', old_string: 'original', new_string: 'x' })
      expect(edit.isError).toBe(true)
      expect(edit.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
      const write = await call('write', { file_path: 'a.txt', content: 'premature' })
      expect(write.isError).toBe(true)
      expect(write.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })

      // A read-not-found is an authoritative negative observation for this
      // owner. It still fails as a read, but changes the next write guard.
      const reread = await call('read', { file_path: 'a.txt' })
      expect(reread.isError).toBe(true)
      expect(reread.error).toMatchObject({ info: { code: 'FS_NOT_FOUND' } })

      // Absence never authorizes edit: there is no content/version to edit.
      const retriedEdit = await call('edit', { file_path: 'a.txt', old_string: 'original', new_string: 'x' })
      expect(retriedEdit.isError).toBe(true)
      expect(retriedEdit.error).toMatchObject({ info: { code: 'FS_NOT_FOUND' } })

      // The retried write uses createIfAbsent; the provider remains responsible
      // for rejecting a concurrent creator at publication time.
      const recovered = await call('write', { file_path: 'a.txt', content: 'fresh' })
      expect(recovered.isError).toBe(false)
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('fresh')
    })
  })

  describe('stat budget', () => {
    it('read stats once; write and edit never stat in the tool (the gate stats zero too)', async () => {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      const statSpy = vi.spyOn(ctx.fs, 'stat')

      // read: exactly one stat (type + size routing + observed version).
      await call('read', { file_path: 'a.txt' })
      expect(statSpy).toHaveBeenCalledTimes(1)

      // edit (guarded, after the read): the gate supplies vObserved; the tool
      // does not stat to manufacture a basis. CAS happens in editText's lock.
      statSpy.mockClear()
      const edited = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
      expect(edited.isError).toBe(false)
      expect(statSpy).not.toHaveBeenCalled()

      // write (guarded replace, after the edit refreshed observed state): zero stat.
      statSpy.mockClear()
      const written = await call('write', { file_path: 'a.txt', content: 'fresh' })
      expect(written.isError).toBe(false)
      expect(statSpy).not.toHaveBeenCalled()
      statSpy.mockRestore()
    })

    it('a missing read still stats once and its recovery write stats zero times', async () => {
      const statSpy = vi.spyOn(ctx.fs, 'stat')
      const missing = await call('read', { file_path: 'missing.txt' })
      expect(missing.isError).toBe(true)
      expect(missing.error).toMatchObject({ info: { code: 'FS_NOT_FOUND' } })
      expect(statSpy).toHaveBeenCalledTimes(1)

      statSpy.mockClear()
      const created = await call('write', { file_path: 'missing.txt', content: 'fresh' })
      expect(created.isError).toBe(false)
      expect(statSpy).not.toHaveBeenCalled()
      statSpy.mockRestore()
    })
  })
})

// --------------------------------------------------------------------------
// BARE deployment: the tool suite WITHOUT the policy gate.
// --------------------------------------------------------------------------
describe('bare provider (no dsh-fs-observation-policy)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-bare-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    fiber = await ctx.plugin(ToolFs)
  })

  it('read works (it never needed policy)', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\nbeta')
    const result = await call('read', { file_path: 'a.txt' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('1: alpha')
  })

  it('write unconditionally creates a new file', async () => {
    const result = await call('write', { file_path: 'new.txt', content: 'fresh' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('fresh')
  })

  it('write unconditionally OVERWRITES an existing unread file', async () => {
    await writeFile(join(dir, 'a.txt'), 'original')
    const result = await call('write', { file_path: 'a.txt', content: 'clobbered' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('clobbered')
  })

  it('edit unconditionally edits an UNREAD existing file', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const result = await call('edit', { file_path: 'a.txt', old_string: 'world', new_string: 'there' })
    expect(result.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello there')
  })

  it('edit of a MISSING target reports FS_STALE_VERSION even on the unguarded path', async () => {
    const result = await call('edit', { file_path: 'missing.txt', old_string: 'a', new_string: 'b' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
    // Even without policy, the stale text carries the re-read remedy.
    expect(text(result)).toContain('file changed since it was read')
    expect(text(result)).toContain('re-read the file, then retry')
  })

  it('edit still enforces literal-match codes (FS_EDIT_NOT_FOUND), unrelated to freshness', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const result = await call('edit', { file_path: 'a.txt', old_string: 'absent', new_string: 'x' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { code: 'FS_EDIT_NOT_FOUND' } })
  })

  it('neither write nor edit stats in the tool on the bare path', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const statSpy = vi.spyOn(ctx.fs, 'stat')
    expect((await call('write', { file_path: 'a.txt', content: 'x y' })).isError).toBe(false)
    expect((await call('edit', { file_path: 'a.txt', old_string: 'y', new_string: 'z' })).isError).toBe(false)
    expect(statSpy).not.toHaveBeenCalled()
    statSpy.mockRestore()
  })
})

// Per-session cwd: a relative file_path resolves against the calling session's workspace
// (`exec.agent.session.header.cwd`), not the backend's config.cwd, so the
// caller-selected session workspace wins, matching dsh-tool-bash.
describe('per-session cwd', () => {
  let sessionDir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-cfg-'))
    sessionDir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-session-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir }) // config.cwd = dir, NOT sessionDir
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(ToolFs)
  })
  afterEach(async () => { await rm(sessionDir, { recursive: true, force: true }) })

  const callIn = (sessionObj: object, name: string, args: unknown) =>
    ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name,
      arguments: args,
      agent: { session: sessionObj } as never,
    })

  it('writes a relative path into the SESSION cwd, not config.cwd', async () => {
    const result = await callIn({ header: { cwd: sessionDir } }, 'write', { file_path: 'note.txt', content: 'hi' })
    expect(result.isError).toBe(false)
    // Verify the WORLD: the file is in the session dir, and NOT in config.cwd.
    expect(await readFile(join(sessionDir, 'note.txt'), 'utf8')).toBe('hi')
    await expect(readFile(join(dir, 'note.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('read + edit both resolve against the session cwd (end-to-end)', async () => {
    // ONE session object across both calls — observed-state keys by owner
    // identity, so read must record under the same owner the edit reads.
    const session = { header: { cwd: sessionDir } }
    await writeFile(join(sessionDir, 'code.txt'), 'alpha')
    expect((await callIn(session, 'read', { file_path: 'code.txt' })).isError).toBe(false)
    const edited = await callIn(session, 'edit', { file_path: 'code.txt', old_string: 'alpha', new_string: 'beta' })
    expect(edited.isError).toBe(false)
    expect(await readFile(join(sessionDir, 'code.txt'), 'utf8')).toBe('beta')
  })
})

// --------------------------------------------------------------------------
// Abort-through-the-tool, tool-tier concurrency, and the fs/observed contract —
// all through ctx.tools.execute() against the REAL backend + policy.
// --------------------------------------------------------------------------
describe('signal, concurrency, and the fs/observed contract', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    fiber = await ctx.plugin(ToolFs)
  })

  const session = { header: {} }
  const callSig = (signal: AbortSignal, name: string, args: unknown) =>
    ctx.tools.execute({ callId: ToolCallId(`c-${++callCounter}`), name, arguments: args, agent: { session } as never, signal })
  const callOwned = (name: string, args: unknown) =>
    ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`c-${++callCounter}`), name, arguments: args, agent: { session } as never })

  it('a pre-aborted registry call skips read/write/edit with ABORTED_BEFORE_DISPATCH', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const read = await callSig(AbortSignal.abort(), 'read', { file_path: 'a.txt' })
    expect(read.isError).toBe(true)
    expect(read.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } })

    const write = await callSig(AbortSignal.abort(), 'write', { file_path: 'new.txt', content: 'x' })
    expect(write.isError).toBe(true)
    expect(write.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } })
    await expect(readFile(join(dir, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // Read first (un-aborted, SAME session owner) so the edit clears the
    // observation gate; then the registry skips the aborted edit before its body.
    expect((await callOwned('read', { file_path: 'a.txt' })).isError).toBe(false)
    const edit = await callSig(AbortSignal.abort(), 'edit', { file_path: 'a.txt', old_string: 'hello', new_string: 'bye' })
    expect(edit.isError).toBe(true)
    expect(edit.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello') // unchanged
  })

  it('two concurrent edits of the same file, same session: one wins, one FS_STALE_VERSION', async () => {
    await writeFile(join(dir, 'a.txt'), 'base value here')
    // One read establishes the observed version both edits guard against; then
    // race two edits so both carry the SAME observed version (the barrier).
    expect((await callOwned('read', { file_path: 'a.txt' })).isError).toBe(false)
    const [one, two] = await Promise.all([
      callOwned('edit', { file_path: 'a.txt', old_string: 'base', new_string: 'ONE', replaceAll: false }),
      callOwned('edit', { file_path: 'a.txt', old_string: 'value', new_string: 'TWO', replaceAll: false }),
    ])
    const errors = [one, two].filter(r => r.isError)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
    // The world is consistent: exactly one edit landed.
    const onDisk = await readFile(join(dir, 'a.txt'), 'utf8')
    expect(onDisk === 'ONE value here' || onDisk === 'base TWO here').toBe(true)
  })

  it('a stale observed version from an older read fails closed at edit CAS', async () => {
    await writeFile(join(dir, 'a.txt'), 'older content\n')
    const target = await ctx.fs.resolve('a.txt')
    const firstInfo = await ctx.fs.stat(target)
    if (!firstInfo) throw new Error('expected first stat')

    expect((await callOwned('read', { file_path: 'a.txt' })).isError).toBe(false)

    await writeFile(join(dir, 'a.txt'), 'newer current content\n')
    const secondInfo = await ctx.fs.stat(target)
    if (!secondInfo) throw new Error('expected second stat')
    expect(secondInfo.version).not.toBe(firstInfo.version)
    expect((await callOwned('read', { file_path: 'a.txt' })).isError).toBe(false)

    // Reproduce an older concurrent read winning the observation race.
    ctx.emit('fs/observed', target, { kind: 'present', version: firstInfo.version }, { agent: { session } })

    const edit = await callOwned('edit', {
      file_path: 'a.txt',
      old_string: 'newer',
      new_string: 'edited',
    })
    expect(edit.isError).toBe(true)
    expect(edit.error).toMatchObject({ info: { code: 'FS_STALE_VERSION' } })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('newer current content\n')
  })

  it('a throwing fs/observed listener surfaces as isError, but the mutation already hit disk', async () => {
    // fs/observed is a plain ctx.emit after the write succeeded; a throwing listener cannot
    // roll the write back — it only turns the tool result into isError.
    ctx.on('fs/observed', () => { throw new Error('recording bug') })
    const result = await callOwned('write', { file_path: 'w.txt', content: 'durable' })
    expect(result.isError).toBe(true)
    expect(await readFile(join(dir, 'w.txt'), 'utf8')).toBe('durable')
  })
})
