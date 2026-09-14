/** Real helper dispatch over private in-memory transport, without changing the Harness process cwd. */
import { symlink, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { z } from 'zod'
import { createHelperHarness as helper } from './fixtures/helper.ts'
import { targetSchema, writeResultSchema, editResultSchema, infoSchema, entriesSchema } from '../src/schemas.ts'


const policy = (workspaceRoot: string) => ({ mode: 'workspace-write', workspaceRoot })

describe.skipIf(process.platform === 'win32')('SSH helper runtime', () => {
  it('binds relative filesystem operations to the negotiated workspace without chdir', async () => {
    const before = process.cwd()
    const test = await helper(false)
    try {
      await expect(test.client.request('heartbeat', {}, z.null())).rejects.toThrow('not accepting')
      const facts = await test.hello()
      expect(facts.workspace).toBe(test.root)
      expect(process.cwd()).toBe(before)
      await expect(test.hello()).rejects.toThrow('already completed')
      await expect(test.client.request('unrecognized', {}, z.unknown())).rejects.toThrow('Unknown SSH helper operation')
      await test.client.request('heartbeat', {}, z.null())
      expect(await test.client.request('fs.resolve', { path: '.' }, targetSchema)).toMatchObject({ targetKey: test.root })
      await test.client.request('close', {}, z.null())
      await expect(test.client.request('fs.stat', {}, z.unknown())).rejects.toThrow('not accepting')
    } finally { await test.close() }
  })

  it('preserves guarded write/edit outcomes and filesystem error codes across RPC', async () => {
    const test = await helper()
    try {
      const target = await test.client.request('fs.resolve', { path: 'file.txt' }, targetSchema)
      const created = await test.client.request('fs.write', { target, content: 'first text', policy: policy(test.root), expected: { kind: 'createIfAbsent' } }, writeResultSchema)
      expect(created).toMatchObject({ operation: 'create', before: null, after: 'first text' })
      await expect(test.client.request('fs.write', { target, content: 'stale', policy: policy(test.root), expected: { kind: 'replaceIfVersion', version: 'stale' } }, writeResultSchema)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      const updated = await test.client.request('fs.write', { target, content: 'second text', policy: policy(test.root), expected: { kind: 'replaceIfVersion', version: created.version } }, writeResultSchema)
      const edited = await test.client.request('fs.edit', { target, edit: { oldString: 'second', newString: 'third', replaceAll: false }, expected: { version: updated.version }, policy: policy(test.root) }, editResultSchema)
      expect(edited.after).toBe('third text')
      await test.client.request('fs.edit', { target, edit: { oldString: 'third', newString: 'fourth', replaceAll: false }, policy: policy(test.root) }, editResultSchema)
      expect(await test.client.request('fs.readText', { target }, z.string())).toBe('fourth text')
      await expect(test.client.request('fs.write', { target, content: 'denied', policy: { mode: 'read-only', workspaceRoot: test.root } }, writeResultSchema)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally { await test.close() }
  })

  it('returns metadata, byte ranges and canonical symlink observations', async () => {
    const test = await helper()
    try {
      await writeFile(`${test.root}/bytes`, 'abcdef')
      await symlink(`${test.root}/bytes`, `${test.root}/link`)
      const target = await test.client.request('fs.resolve', { path: 'link', cwd: test.root }, targetSchema)
      expect(target.targetKey).toBe(`${test.root}/bytes`)
      expect(await test.client.request('fs.lstat', { path: 'link', cwd: test.root }, z.unknown())).toMatchObject({ type: 'symlink' })
      expect(await test.client.request('fs.lstat', { path: 'absent' }, z.null())).toBeNull()
      expect(await test.client.request('fs.stat', { target }, infoSchema)).toMatchObject({ type: 'file', size: 6 })
      const missing = await test.client.request('fs.resolve', { path: 'absent' }, targetSchema)
      expect(await test.client.request('fs.stat', { target: missing }, z.null())).toBeNull()
      expect(Buffer.from(await test.client.request('fs.readBytes', { target, maxBytes: 16 }, z.string()), 'base64').toString()).toBe('abcdef')
      expect(Buffer.from(await test.client.request('fs.readRange', { target, offset: 1, length: 3 }, z.string()), 'base64').toString()).toBe('bcd')
      const directory = await test.client.request('fs.resolve', { path: '.' }, targetSchema)
      expect((await test.client.request('fs.list', { target: directory }, entriesSchema)).map(entry => entry.name)).toContain('bytes')
      await expect(test.client.request('fs.readRange', { target, offset: -1, length: 3 }, z.string())).rejects.toThrow()
    } finally { await test.close() }
  })

  it('closes remote text iterators after completion and explicit early return', async () => {
    const test = await helper()
    try {
      await writeFile(`${test.root}/text`, 'streamed')
      const target = await test.client.request('fs.resolve', { path: 'text' }, targetSchema)
      const nextSchema = z.object({ done: z.boolean(), value: z.string() })
      const id = await test.client.request('fs.stream', { target }, z.string())
      expect(await test.client.request('fs.next', { id }, nextSchema)).toEqual({ done: false, value: 'streamed' })
      let next = await test.client.request('fs.next', { id }, nextSchema)
      while (!next.done) {
        expect(next.value).toBe('')
        next = await test.client.request('fs.next', { id }, nextSchema)
      }
      expect(next.value).toBe('')
      await expect(test.client.request('fs.next', { id }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
      const early = await test.client.request('fs.stream', { target }, z.string())
      await test.client.request('fs.streamClose', { id: early }, z.null())
      await expect(test.client.request('fs.next', { id: early }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
    } finally { await test.close() }
  })

  it('refuses unconfined sandbox requests and resolves executables in the helper world', async () => {
    const test = await helper()
    const confine = vi.spyOn(LocalSandboxProvider.prototype, 'confine').mockImplementation(async argv => ({
      argv: ['confined', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
    }))
    try {
      await expect(test.client.request('sandbox', { argv: ['true'], policy: { mode: 'danger-full-access', workspaceRoot: test.root } }, z.unknown())).rejects.toThrow('does not need')
      expect(await test.client.request('executable', { command: process.execPath, env: { REMOVED: null } }, z.string())).toBe(process.execPath)
      expect(await test.client.request('executable', { command: process.execPath }, z.string())).toBe(process.execPath)
      expect(await test.client.request('terminal.environment', {}, z.unknown())).toMatchObject({ platform: 'posix' })
      await expect(test.client.request('executable', { command: `${test.root}/absent` }, z.string())).rejects.toMatchObject({ code: 'SUBPROCESS_EXECUTABLE_NOT_FOUND' })
      await expect(test.client.request('executable', { command: './relative' }, z.string())).rejects.toThrow('relative')
      const wrapped = await test.client.request('sandbox', { argv: ['true'], policy: policy(test.root) }, z.looseObject({ argv: z.array(z.string()), enforcement: z.enum(['full', 'partial']) }))
      expect(wrapped.argv).toEqual(['confined', 'true'])
      expect(confine).toHaveBeenCalledWith(['true'], policy(test.root), expect.any(AbortSignal))
    } finally { confine.mockRestore(); await test.close() }
  })
})
