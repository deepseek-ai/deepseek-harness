/** Helper shutdown joins completed-process resources before relinquishing ownership. */
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { authenticateStream } from '../src/stream-security.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

describe.skipIf(process.platform === 'win32')('SSH completed-process cleanup ownership', () => {
  it.each(['success', 'failure'] as const)('joins finalization after native %s while retaining the direct result', async (kind) => {
    const root = await mkdtemp('/tmp/dsh-ssh-final-')
    const ctx = new Context()
    const filesystem = await ctx.plugin(LocalFileSystem, { cwd: root })
    const subprocess = await ctx.plugin(LocalSubprocessRuntime)
    const owner = new RemoteProcesses(ctx, root, 1, 5000)
    const sockets: Socket[] = []
    const removing = Promise.withResolvers<undefined>()
    const releaseRemoval = Promise.withResolvers<undefined>()
    const removed = Promise.withResolvers<undefined>()
    let removalStarted = false
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    try {
      const prepared = await owner.prepare({
        argv: kind === 'success' ? [process.execPath, '-e', 'process.exit(0)'] : [join(root, 'missing-executable')],
        cwd: root, graceMs: 50, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      })
      const directory = join(root, prepared.id)
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (path !== directory) return actual.rm(path, options)
        removalStarted = true
        removing.resolve(undefined)
        await releaseRemoval.promise
        try { await actual.rm(path, options) }
        finally { removed.resolve(undefined) }
      })
      for (const endpoint of Object.values(prepared.streams)) {
        const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
        raw.on('error', () => {})
        sockets.push(raw)
        await once(raw, 'connect')
        const socket = await authenticateStream(raw, endpoint.capability, 5000)
        socket.on('error', () => {})
        sockets.push(socket)
        socket.end(); socket.resume()
      }
      await owner.start(prepared.id)
      const outcome = await owner.done(prepared.id).then(
        value => ({ value }), (error: unknown) => ({ error }),
      )
      if (kind === 'failure') expect(outcome).toMatchObject({ error: { code: 'ENOENT' } })
      else expect(outcome).toMatchObject({ value: { outcome: { exitCode: 0 } } })
      await removing.promise
      let closed = false
      const close = owner.close().then(() => { closed = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      releaseRemoval.resolve(undefined)
      await close
      expect(await readdir(root)).toEqual([])
      const late = await owner.done(prepared.id).then(
        value => ({ value }), (error: unknown) => ({ error }),
      )
      expect(late).toEqual(outcome)
      if ('error' in outcome) expect('error' in late && late.error).toBe(outcome.error)
    } finally {
      releaseRemoval.resolve(undefined)
      for (const socket of sockets) socket.destroy()
      await owner.close()
      if (removalStarted) await removed.promise
      await subprocess.dispose()
      await filesystem.dispose()
      vi.mocked(rm).mockImplementation(actual.rm)
      await rm(root, { recursive: true, force: true })
    }
  })
})
