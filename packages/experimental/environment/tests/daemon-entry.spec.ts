import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ENVIRONMENT_PROTOCOL_VERSION, RpcPeer } from '../src/protocol.ts'
import { shipped } from './fixtures/definitions.ts'
import { exists } from './fixtures/processes.ts'

const entry = fileURLToPath(new URL('../src/daemon-entry.ts', import.meta.url))
const limits = { maxFrameBytes: 65536, maxMessageBytes: 1024 * 1024, maxPending: 4, cancelGraceMs: 10_000 }
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function started(args = ['serve', '--stdio']): Promise<{ child: ChildProcess; peer: RpcPeer; exited: Promise<[number | null, NodeJS.Signals | null]> }> {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  const peer = new RpcPeer(child.stdout, child.stdin, limits)
  await peer.request('auth', { protocol: ENVIRONMENT_PROTOCOL_VERSION, mechanisms: ['transport'], limits: { ...limits, killGraceMs: 100 } })
  return { child, peer, exited }
}

describe('provider-owned stdio execution process', () => {
  it('reuses one process for several runs and starts independently for a new connection', async () => {
    const first = await started()
    const request = { run: 1, ...shipped('() => "ready"'), args: null }
    await expect(first.peer.request('run', request)).resolves.toBe('ready')
    await expect(first.peer.request('run', { ...request, run: 2 })).resolves.toBe('ready')
    first.child.stdin!.end()
    expect((await first.exited)[0]).toBe(0)
    const second = await started()
    expect(second.child.pid).not.toBe(first.child.pid)
    await expect(second.peer.request('run', request)).resolves.toBe('ready')
  })

  it('discards worker output, which would otherwise corrupt the protocol on standard output', async () => {
    const { peer } = await started()
    // Shipped code can reach its worker's `process` through any function constructor.
    const source = '(_args, env) => { new env.signal.constructor.constructor("return process")().stdout.write("noise\\n"); return "quiet" }'
    await expect(peer.request('run', { run: 1, ...shipped(source), args: null })).resolves.toBe('quiet')
    await expect(peer.request('run', { run: 2, ...shipped('() => "intact"'), args: null })).resolves.toBe('intact')
    expect(peer.failed).toBe(false)
  })

  it.each([
    ['eof', false], ['eof', true],
    // Windows TerminateProcess does not deliver a catchable SIGTERM to the daemon.
    ...process.platform === 'win32' ? [] : [['SIGTERM', false] as const],
  ] as const)('drains exec descendants before exiting on %s (parent exits on TERM: %s)', async (stop, parentExits) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-environment-stdio-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'pid')
    const { child, peer, exited } = await started()
    let pids: number[] = []
    cleanups.push(async () => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL') } catch (error) {
          // ESRCH: normal shutdown already reaped the test process.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    })
    const grandchild = 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'
    const script = [
      `process.on('SIGTERM', () => { ${parentExits ? 'process.exit()' : ''} })`,
      `const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
      `child.once('message', () => require('fs').writeFileSync(${JSON.stringify(file)}, process.pid + ' ' + child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('; ')
    const pending = peer.request('run', {
      run: 1, ...shipped('async ({node, script}, env) => await env.exec([node, "-e", script])'),
      args: { node: process.execPath, script },
    })
    const rejected = expect(pending).rejects.toThrow()
    const recorded = async (): Promise<number[]> => (await readFile(file, 'utf8').catch(() => '')).split(' ').map(Number).filter(pid => pid > 0)
    await expect.poll(recorded).toHaveLength(2)
    pids = await recorded()
    if (stop === 'eof') child.stdin!.end()
    else child.kill('SIGTERM')
    await exited
    await rejected
    const expected = process.platform === 'win32' ? pids.slice(0, 1) : pids
    await expect.poll(() => expected.filter(exists)).toEqual([])
  })
})
