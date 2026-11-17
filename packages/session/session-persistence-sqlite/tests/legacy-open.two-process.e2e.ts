/** Built-package ownership during concurrent legacy import and SQLite handoff. @module */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Interface } from 'node:readline'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as persistence from '../src/index.ts'
import { eventLines, generationLogPath, toHeaderLine } from '../../session-persistence-jsonl/src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const opener = fileURLToPath(new URL('./fixtures/legacy-opener.mjs', import.meta.url))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-import-process-'))
  const contexts: Context[] = []
  const children: { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; lines: Interface }[] = []
  onTestFinished(async () => {
    try {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await Promise.all(children.map(async (probe) => {
        await probe.closed
        probe.lines.close()
      }))
      for (const context of contexts) await context.fiber.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  const id = SessionId('legacy-process')
  const path = await store(id)
  const bytes = await readFile(path)
  async function store(target: SessionId) {
    const header = meta(target)
    const path = generationLogPath(root, header.cwd, target, header.version, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(toHeaderLine(header)) + '\n' + eventLines(oneTurnLog()) + '\n')
    return path
  }
  function launch(access = 'read', pause = '', target = id) {
    const child = spawn(process.execPath, [opener, root, target, access, pause], { stdio: ['pipe', 'pipe', 'inherit'] })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    const lines = createInterface({ input: child.stdout })
    const iterator = lines[Symbol.asyncIterator]()
    const probe = {
      child, closed, lines,
      async status() {
        const line = await iterator.next()
        if (line.done) throw new Error('Legacy opener closed before reporting status')
        return line.value
      },
      async close() {
        child.stdin.end('close\n')
        expect(await closed).toEqual({ code: 0, signal: null })
      },
    }
    children.push(probe)
    return probe
  }
  async function mount() {
    const context = new Context()
    contexts.push(context)
    await context.plugin(persistence, { root, compression: 'none' })
    return context.sessionPersistence
  }
  return { root, id, path, bytes, store, launch, mount }
}

describe('legacy import across processes', { retry: 0 }, () => {
  it('initializes one database while two processes first open different Sessions', async () => {
    const b = await fixture()
    const otherId = SessionId('other-legacy-process')
    await b.store(otherId)
    const first = b.launch('read', 'start'), second = b.launch('read', 'start', otherId)
    expect(await Promise.all([first.status(), second.status()])).toEqual(['ready', 'ready'])
    first.child.stdin.write('continue\n')
    second.child.stdin.write('continue\n')
    expect(await Promise.all([first.status(), second.status()])).toEqual(['opened', 'opened'])
    await Promise.all([first.close(), second.close()])
    const persistence = await b.mount()
    expect((await persistence.list()).map(entry => entry.header.id).sort()).toEqual([b.id, otherId].sort())
    for (const id of [b.id, otherId]) {
      await using read = await persistence.open(id, 'read')
      expect((await read.read()).events).toEqual(oneTurnLog())
    }
  })

  it.each(['read', 'write'])('waits for another process to import and hands off %s access', async (access) => {
    const b = await fixture(), first = b.launch(access, 'pause')
    expect(await first.status()).toBe('reading')
    const competing = b.launch('read', 'wait')
    expect(await competing.status()).toBe('contended')
    first.child.stdin.write('continue\n')
    expect(await first.status()).toBe('opened')
    expect(await competing.status()).toBe('opened')
    await competing.close()
    const currentReader = b.launch()
    expect(await currentReader.status()).toBe('opened')
    await currentReader.close()
    if (access === 'write') {
      const competingWriter = b.launch('write')
      expect(await competingWriter.status()).toBe('SessionAlreadyOwnedError')
      expect(await competingWriter.closed).toEqual({ code: 0, signal: null })
    }
    await first.close()
    expect(await readFile(b.path)).toEqual(b.bytes)
    const persistence = await b.mount()
    await using read = await persistence.open(b.id, 'read')
    expect((await read.read()).events).toEqual(oneTurnLog())
  })

  it('releases import ownership after process death and retries the complete import', async () => {
    const b = await fixture(), first = b.launch('write', 'pause')
    expect(await first.status()).toBe('reading')
    first.child.kill('SIGKILL')
    const result = await first.closed
    // Windows reports forced termination as an exit code rather than a POSIX signal.
    if (process.platform === 'win32') expect(result.code).not.toBe(0)
    else expect(result.signal).toBe('SIGKILL')
    const retry = b.launch('write')
    expect(await retry.status()).toBe('opened')
    await retry.close()
    expect(await readFile(b.path)).toEqual(b.bytes)
    const persistence = await b.mount()
    await using read = await persistence.open(b.id, 'read')
    expect((await read.read()).events).toEqual(oneTurnLog())
  })
})
