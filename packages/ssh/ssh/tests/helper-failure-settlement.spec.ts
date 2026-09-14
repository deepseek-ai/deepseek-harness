/** Failed native launches release remote capacity while retaining the original result error. */
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { authenticateStream } from '../src/stream-security.ts'

describe.skipIf(process.platform === 'win32')('SSH failed process settlement', () => {
  it('reuses a one-process capacity after ENOENT and preserves late done errors', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-failed-')
    const ctx = new Context()
    const filesystem = await ctx.plugin(LocalFileSystem, { cwd: root })
    const subprocess = await ctx.plugin(LocalSubprocessRuntime)
    const owner = new RemoteProcesses(ctx, root, 1, 5000)
    const sockets: Socket[] = []
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const prepared = await owner.prepare({
          argv: [`${root}/missing-executable`], cwd: root, graceMs: 50,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        })
        for (const endpoint of Object.values(prepared.streams)) {
          const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
          await once(raw, 'connect')
          const socket = await authenticateStream(raw, endpoint.capability, 5000)
          socket.on('error', () => {})
          sockets.push(socket)
          socket.end(); socket.resume()
        }
        await owner.start(prepared.id)
        const failure = await owner.done(prepared.id).catch((error: unknown) => error)
        expect(failure).toMatchObject({ code: 'ENOENT' })
        await owner.terminate(prepared.id)
        expect(await owner.wait(prepared.id)).toBe(true)
        await vi.waitFor(async () => { expect(await readdir(root)).toEqual([]) })
        await expect(owner.done(prepared.id)).rejects.toBe(failure)
      }
    } finally {
      for (const socket of sockets) socket.destroy()
      await owner.close()
      await subprocess.dispose()
      await filesystem.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
