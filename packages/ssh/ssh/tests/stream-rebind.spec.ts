/** A confined process may replace a writable socket path but cannot read authenticated stream bytes. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { authenticateStream } from '../src/stream-security.ts'

describe.skipIf(process.platform === 'win32')('SSH stream pathname replacement', () => {
  it('keeps the key and payload private when a workspace-write process rebinds and relays the listener', async ({ skip }) => {
    const root = await realpath(await mkdtemp('/tmp/dsh-ssh-rebind-'))
    const ctx = new Context()
    const fs = ctx.plugin(LocalFileSystem, { cwd: root })
    const subprocess = ctx.plugin(LocalSubprocessRuntime)
    const sandbox = ctx.plugin(LocalSandboxProvider)
    await Promise.all([fs, subprocess, sandbox])
    const owner = new RemoteProcesses(ctx, root, 4, 5000)
    const sockets: Socket[] = []
    let attacker: SubprocessHandle | undefined
    try {
      try { await ctx.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: root }) }
      catch (error) {
        if (error instanceof SandboxUnavailableError) skip('No local process confinement backend is available')
        throw error
      }
      const prepared = await owner.prepare({
        argv: [process.execPath, '-e', 'const s=new(require(\'node:net\').Socket)({fd:7,readable:true,writable:true});const chunks=[];s.on(\'data\',v=>chunks.push(v));s.on(\'end\',()=>s.end(Buffer.concat(chunks)));'],
        cwd: root, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
      })
      const endpoint = prepared.streams.control!
      const capture = `${root}/captured-tls`
      const relay = 'const fs=require(\'node:fs\'),net=require(\'node:net\'),p=process.argv[1];fs.renameSync(p,p+\'.saved\');net.createServer({allowHalfOpen:true},front=>{const back=net.createConnection({path:p+\'.saved\',allowHalfOpen:true});front.on(\'data\',v=>fs.appendFileSync(process.argv[2],v));back.on(\'data\',v=>fs.appendFileSync(process.argv[2],v));front.on(\'error\',()=>back.destroy());back.on(\'error\',()=>front.destroy());front.pipe(back).pipe(front)}).listen(p,()=>process.stdout.write(\'rebound\\n\'));'
      const confined = await ctx.sandbox.confine([process.execPath, '-e', relay, endpoint.path, capture], {
        mode: 'workspace-write', workspaceRoot: root,
      })
      attacker = ctx.subprocess.spawn({
        argv: confined.argv, cwd: root, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } },
      })
      const [ready] = await once(attacker.stdout!, 'data') as [Buffer]
      expect(Buffer.from(ready).toString()).toBe('rebound\n')
      let control: Socket | undefined
      for (const [name, value] of Object.entries(prepared.streams)) {
        const raw = createConnection(value.path)
        await once(raw, 'connect')
        const secured = await authenticateStream(raw, value.capability, 5000)
        sockets.push(secured)
        if (name === 'control') control = secured
        else { secured.end(); secured.resume() }
      }
      const secret = `private-process-payload-${randomUUID()}`
      const received: Buffer[] = []
      const reading = (async () => { for await (const bytes of control!) received.push(Buffer.from(bytes as Uint8Array)) })()
      await owner.start(prepared.id)
      control!.end(secret)
      await reading
      expect(Buffer.concat(received).toString()).toBe(secret)
      expect(await owner.wait(prepared.id)).toBe(true)
      const observed = await readFile(capture)
      expect(observed.length).toBeGreaterThan(secret.length)
      expect(observed.includes(Buffer.from(secret))).toBe(false)
      expect(observed.includes(Buffer.from(endpoint.capability, 'hex'))).toBe(false)
      expect(observed.includes(Buffer.from(endpoint.capability))).toBe(false)
    } finally {
      for (const socket of sockets) socket.destroy()
      attacker?.terminate()
      await attacker?.waitForExit()
      await owner.close()
      for (const fiber of [sandbox, subprocess, fs]) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
