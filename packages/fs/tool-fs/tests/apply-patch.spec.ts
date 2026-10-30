/** The registered patch capability shares native/PTC values and preserves known partial effects. */
import { chmod, mkdir, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { expect, it, vi } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { PtcRunRequest, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { add, move, patch, remove, setup, update } from './patch/harness.ts'

const guidance = 'Prefer apply_patch over separate edit calls for changes across files or separated regions. '
  + 'Read a file before updating, deleting, or moving it (the default fs-observation-policy requires it), unless you just created or edited it in this session. '
  + 'The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.'

type Fixture = Awaited<ReturnType<typeof setup>>
function call(t: Fixture, text: string) {
  return executeToolFixture(t.ctx, { ...t.exec, arguments: { input: text } })
}

it('omits patch registration and guidance when disabled', async () => {
  const t = await setup({ applyPatch: false })
  expect(t.ctx.tools.get('apply_patch')).toBeUndefined()
  expect((await t.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:apply_patch')).toBeUndefined()
})

it('registers patch guidance when enabled and removes tool and section on disposal', async () => {
  const t = await setup()
  expect(t.ctx.tools.get('apply_patch')?.description).toBe('Create, update, delete, or move UTF-8 text files with one Codex-style patch; '
    + 'prefer it over multiple edit calls when a change spans several files or separated regions.')
  const key = {}
  let scope!: Scope
  await t.ctx.plugin(Object.assign((ctx: Context) => { scope = createScope(ctx, key) }, { inject: ['tools', 'systemPrompt'] }))
  const section = () => t.ctx.systemPrompt.assemble({ scope: key }).then(value => value.sections.find(section => section.name === 'tool:apply_patch'))
  expect((await section())?.text).toBe(guidance)
  const release = scope.ctx.tools.restrict({ deny: ['apply_patch'] })
  expect((await section())?.text).toBe('')
  release()
  expect((await section())?.text).toBe(guidance)
  await t.toolFiber.dispose()
  expect(t.ctx.tools.get('apply_patch')).toBeUndefined()
  expect(await section()).toBeUndefined()
})

it('returns exact native values and applied metadata for all four operation kinds', async () => {
  const t = await setup()
  await t.file('edit', 'old\n')
  await t.file('delete', 'gone\n')
  await t.file('source', 'old\n')
  const result = await call(t, patch(update('edit'), add('created'), remove('delete'), move('source', 'destination')))
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected commit result')
  const path = (name: string) => resolve(t.workspace, name)
  expect(result.value).toEqual({ phase: 'commit', cancelled: false, operations: [
    { ...t.record('update', 'edit'), status: 'completed', changes: [{ path: path('edit'), before: 'old\n', after: 'new\n' }] },
    { ...t.record('add', 'created', 1, 6), status: 'completed', changes: [{ path: path('created'), before: null, after: 'new\n' }] },
    { ...t.record('delete', 'delete', 2, 8), status: 'completed', changes: [{ path: path('delete'), before: 'gone\n', after: null }] },
    { ...t.record('move', 'source', 3, 9, 'destination'), status: 'completed', changes: [
      { path: path('destination'), before: null, after: 'new\n' }, { path: path('source'), before: 'old\n', after: null },
    ] },
  ], affectedPaths: ['edit', 'created', 'delete', 'destination', 'source'].map(path) })
  expect(result.content).toEqual([{ type: 'text', text: `Success. Updated the following files:\nA ${path('created')}\nM ${path('edit')}\nM ${path('destination')}\nD ${path('delete')}` }])
  // Creations store no diff, as for write; removals store the provider's bounded basis.
  expect(result.meta).toEqual({ stopped: false, diffs: [
    { path: path('edit'), oldText: 'old', newText: 'new' },
    { path: path('delete'), oldText: 'gone\n', newText: '' },
    { path: path('source'), oldText: 'old\n', newText: '' },
  ] })
  expect(await t.bytes('edit')).toBe('new\n')
  expect(await t.bytes('destination')).toBe('new\n')
  await expect(t.bytes('source')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('returns the empty patch confirmation', async () => {
  const t = await setup()
  const result = await call(t, patch())
  expect(result).toMatchObject({ isError: false, value: { phase: 'commit', cancelled: false, operations: [], affectedPaths: [] },
    content: [{ type: 'text', text: 'Success. No operations in patch.' }], meta: { diffs: [], stopped: false } })
})

it('throws typed syntax and aggregated unread-file refusals without diffs', async () => {
  const t = await setup()
  const syntax = await call(t, 'invalid')
  expect(syntax.isError).toBe(true)
  expect(syntax.error?.info).toEqual({ name: 'PatchToolError', code: 'PATCH_SYNTAX' })
  expect(syntax.content).toEqual([{ type: 'text', text: "Error: Invalid patch at line 1: Expected '*** Begin Patch'" }])
  await t.file('a', 'old\n', false)
  await t.file('b', 'old\n', false)
  const result = await call(t, patch(update('a'), update('b')))
  expect(result.isError).toBe(true)
  expect(result.error?.info).toEqual({ name: 'FsError', code: 'FS_NOT_OBSERVED' })
  expect(result.content).toEqual([{ type: 'text', text: 'Error: Patch rejected before any change (2 problems):\n'
    + `- operation 1 (update ${resolve(t.workspace, 'a')}, patch line 2): cannot modify "${resolve(t.workspace, 'a')}": file has not been read — read the file, then retry\n`
    + `- operation 2 (update ${resolve(t.workspace, 'b')}, patch line 6): cannot modify "${resolve(t.workspace, 'b')}": file has not been read — read the file, then retry` }])
  expect(result.meta).toBeUndefined()
  expect(await t.bytes('a')).toBe('old\n')
})

it.skipIf(process.platform === 'win32')('preserves the symbolic-link refusal code', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  await symlink('a', resolve(t.workspace, 'link'))
  const result = await call(t, patch(remove('link')))
  expect(result.error?.info).toEqual({ name: 'PatchToolError', code: 'PATCH_SYMLINK_SOURCE' })
})

it('keeps a partial move as a value with its destination diff and exact stop text', async () => {
  const t = await setup()
  await t.file('a', 'old\n')
  vi.spyOn(t.fs, 'moveFile').mockImplementation(async (source, destination, options, signal) => {
    // Preserve the actual destination write while deterministically retaining the source.
    const read = await t.fs.readText(source)
    const outcome = await t.fs.writeText(destination, 'new\n', options.expectedDestination, signal)
    return { sourceBefore: read, destination: outcome, sourceDeleted: false,
      sourceFailure: { code: 'FS_PERMISSION_DENIED', message: 'source removal denied' } }
  })
  const result = await call(t, patch(add('first'), move('a', 'b'), add('last')))
  expect(result.isError).toBe(false)
  const path = (name: string) => resolve(t.workspace, name)
  expect(result.content).toEqual([{ type: 'text', text: `Patch stopped after 1 of 3 operations.\nCompleted:\nA ${path('first')}\nFailed:\n`
    + `- operation 2 (move ${path('a')} -> ${path('b')}, patch line 4): source removal denied\n`
    + `  destination ${path('b')} was written; source ${path('a')} remains\nNot executed:\n- operation 3 (add ${path('last')})` }])
  expect(result.meta).toEqual({ stopped: true, diffs: [] })
  expect(await t.bytes('a')).toBe('old\n')
  expect(await t.bytes('b')).toBe('new\n')
  await expect(t.bytes('last')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports uncertain writes with no invented diff and the reread remedy', async () => {
  const t = await setup()
  const write = t.fs.writeText.bind(t.fs)
  vi.spyOn(t.fs, 'writeText').mockImplementation(async (...args) => {
    await write(...args)
    throw new FsError('connection lost', 'FS_IO_ERROR')
  })
  const result = await call(t, patch(add('a'), add('b')))
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: 'Patch stopped after 0 of 2 operations.\nOutcome unknown:\n'
    + `- operation 1 (add ${resolve(t.workspace, 'a')}, patch line 2): connection lost — re-read the affected files before retrying\n`
    + `Not executed:\n- operation 2 (add ${resolve(t.workspace, 'b')})` }])
  expect(result.meta).toEqual({ diffs: [], stopped: true })
})

it('advertises escalation only for a confining backend and throws the sandbox refusal', async () => {
  const bare = await setup()
  expect(bare.ctx.tools.get('apply_patch')?.parameters).not.toHaveProperty('properties.sandbox_permissions')
  const t = await setup({ mode: 'read-only' })
  expect(t.ctx.tools.get('apply_patch')?.parameters).toHaveProperty('properties.sandbox_permissions')
  // The provider denies the first commit; with nothing written, the tool rejects like a preflight refusal.
  const result = await executeToolFixture(t.ctx, { signal: t.exec.signal, callId: t.exec.callId, name: 'apply_patch',
    arguments: { input: patch(add(resolve(t.workspace, 'a')), add(resolve(t.workspace, 'b'))) } })
  expect(result.error?.info).toEqual({ name: 'FsError', code: 'FS_SANDBOX_DENIED' })
  expect(result.content).toEqual([{ type: 'text', text: `Error: Patch rejected before any change (1 problems):\n- operation 1 (add ${resolve(t.workspace, 'a')}, patch line 2): [sandbox: file access denied under read-only mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]` }])
  expect(result.meta).toBeUndefined()
})

class PatchPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  patch = ''
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(request: PtcRunSpec) {
    return { logs: [], value: await request.bindings[0]!.functions.apply_patch!({ input: this.patch }) }
  }
}

it('dispatches native and PTC patch calls with identical values', async () => {
  const t = await setup({ policy: false })
  const p = await setup({ toolMode: 'ptc', policy: false })
  await p.ctx.plugin(PatchPtcRuntime)
  const runtime = p.ctx.ptcRuntime as PatchPtcRuntime
  runtime.patch = patch(update(resolve(t.workspace, 'a')))
  await t.file('a', 'old\n')
  const native = await call(t, runtime.patch)
  if (native.isError) throw new Error('expected native success')
  await t.file('a', 'old\n')
  const ptc = await executeModelToolFixture(p.ctx, {
    signal: p.exec.signal, callId: p.exec.callId, agent: { ctx: p.ctx, session: { header: { cwd: t.workspace }, append() {} } } as never,
    name: 'run_code', arguments: { code: 'return await tools.apply_patch({patch})', description: 'Apply the fixture patch' },
  })
  if (ptc.isError) throw new Error(JSON.stringify(ptc))
  expect(ptc.value).toEqual({ logs: [], result: native.value })
  expect(await t.bytes('a')).toBe('new\n')
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('retains completed operations after a real write permission failure', async () => {
  const t = await setup()
  const locked = resolve(t.workspace, 'locked')
  await mkdir(locked, { mode: 0o555 })
  try {
    const result = await call(t, patch(add('first'), add('locked/denied'), add('last')))
    expect(result.isError).toBe(false)
    const first = resolve(t.workspace, 'first')
    const denied = resolve(locked, 'denied')
    expect(result.content).toEqual([{ type: 'text', text: `Patch stopped after 1 of 3 operations.\nCompleted:\nA ${first}\nFailed:\n`
      + `- operation 2 (add ${denied}, patch line 4): cannot write "${denied}": permission denied\nNot executed:\n`
      + `- operation 3 (add ${resolve(t.workspace, 'last')})` }])
    expect(result.meta).toEqual({ stopped: true, diffs: [] })
    expect(await t.bytes('first')).toBe('new\n')
    await expect(t.bytes('last')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await chmod(locked, 0o755) }
})
