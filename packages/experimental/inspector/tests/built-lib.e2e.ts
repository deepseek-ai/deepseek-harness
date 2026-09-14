import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { pnpmInvocation } from '../../../../scripts/pnpm-invocation.ts'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const built = [
  'lib/index.js',
  'node_modules/@deepseek-ai/schemastery/lib/index.mjs',
].every(file => existsSync(join(packageDirectory, file)))

describe.skipIf(!built)('experimental Inspector built artifact', () => {
  it('packs its sibling Worker and evaluates the Host from the tarball through plain Node', { retry: 0 }, async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-inspector-packed-'))
    const consumer = join(root, 'package')
    const dependencies = join(consumer, 'node_modules')
    let linked = false
    let pending: Promise<string> = Promise.resolve('')
    test.onTestFinished(async () => {
      try {
        await pending
      } finally {
        if (linked) await unlink(dependencies)
        await rm(root, { recursive: true, force: true })
      }
    })
    const run = (command: string, args: string[], cwd: string): Promise<string> => {
      pending = execa(command, args, {
        cwd,
        stdin: 'ignore',
        timeout: test.task.timeout,
        cancelSignal: test.signal,
        killSignal: 'SIGKILL',
        reject: false,
      }).then((result) => {
        expect(result.timedOut, `stderr:\n${result.stderr}`).toBe(false)
        expect(result.isCanceled, `stderr:\n${result.stderr}`).toBe(false)
        expect(result.signal, `stderr:\n${result.stderr}`).toBeUndefined()
        expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
        return result.stdout
      })
      return pending
    }
    const invocation = pnpmInvocation(['pack', '--pack-destination', root])
    await run(invocation.command, invocation.args, packageDirectory)
    const archives = (await readdir(root)).filter(name => name.endsWith('.tgz'))
    expect(archives).toHaveLength(1)
    await run('tar', ['-xzf', join(root, archives[0]!), '-C', root], root)
    expect(existsSync(join(consumer, 'lib/worker.js'))).toBe(true)
    await symlink(join(packageDirectory, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir')
    linked = true
    const script = `
      const { startInspector } = await import('@deepseek-ai/dsh-experimental-inspector')
      const { default: WebSocket } = await import('ws')
      globalThis.__builtInspectorProbe = 42
      const inspector = await startInspector({ port: 0, captureFetch: false, startupTimeoutMs: ${String(test.task.timeout)} })
      const socket = new WebSocket(inspector.endpoint.webSocketDebuggerUrl)
      try {
        await new Promise((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CDP response timeout')), 5000)
          socket.on('message', data => {
            const message = JSON.parse(Buffer.from(data).toString('utf8'))
            if (message.id !== 1) return
            clearTimeout(timer)
            resolve(message)
          })
        })
        socket.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: 'globalThis.__builtInspectorProbe', returnByValue: true },
        }))
        const message = await response
        console.log(JSON.stringify(message.result.result))
      } finally {
        socket.terminate()
        await inspector.close()
      }
    `
    const stdout = await run(process.execPath, ['--input-type=module', '-e', script], consumer)
    expect(JSON.parse(stdout.trim()) as unknown).toEqual({ type: 'number', value: 42, description: '42' })
  })
})
