/** Real process ownership during legacy import and SQLite handle handoff. @module */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as persistence from '../src/index.ts'
import { eventLines, generationLogPath, toHeaderLine } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const opener = fileURLToPath(new URL('./fixtures/legacy-opener.mjs', import.meta.url))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-legacy-process-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const id = SessionId('legacy-process'), header = meta(id)
  const path = generationLogPath(root, header.cwd, id, header.version, 'none')
  const bytes = Buffer.from(JSON.stringify(toHeaderLine(header)) + '\n' + eventLines(oneTurnLog()) + '\n')
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
  const launch = (access = 'read', pause = '', target = id) => {
    const child = spawn(process.execPath, [opener, root, target, access, pause], { stdio: ['pipe', 'pipe', 'inherit'] })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => { resolve() })
    })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    })
    const status = async () => {
      const line = await lines.next()
      if (line.done) throw new Error('Legacy opener exited before reporting status')
      return line.value
    }
    return { child, status, exited }
  }
  return { root, id, path, bytes, launch }
}

it('initializes one database while two processes first open different Sessions', async () => {
  const b = await fixture()
  const otherId = SessionId('other-legacy-process'), otherHeader = meta(otherId)
  const otherPath = generationLogPath(b.root, otherHeader.cwd, otherId, otherHeader.version, 'none')
  await mkdir(dirname(otherPath), { recursive: true })
  await writeFile(otherPath, JSON.stringify(toHeaderLine(otherHeader)) + '\n' + eventLines(oneTurnLog()) + '\n')
  const first = b.launch('read', 'start'), second = b.launch('read', 'start', otherId)
  expect(await Promise.all([first.status(), second.status()])).toEqual(['ready', 'ready'])
  first.child.stdin.write('continue\n')
  second.child.stdin.write('continue\n')
  expect(await Promise.all([first.status(), second.status()])).toEqual(['opened', 'opened'])
  first.child.stdin.end('close\n')
  second.child.stdin.end('close\n')
  await Promise.all([first.exited, second.exited])
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(persistence, { root: b.root, compression: 'none' })
  for (const id of [b.id, otherId]) {
    await using read = await ctx.sessionPersistence.open(id, 'read')
    expect((await read.read()).events).toEqual(oneTurnLog())
  }
}, 30_000)

it.each(['read', 'write'])('excludes another process during migration and hands off %s access', async (access) => {
  const b = await fixture()
  const first = b.launch(access, 'pause')
  expect(await first.status()).toBe('reading')
  const competing = b.launch()
  expect(await competing.status()).toBe('SessionAlreadyOwnedError')
  await competing.exited
  first.child.stdin.write('continue\n')
  expect(await first.status()).toBe('opened')
  const currentReader = b.launch()
  expect(await currentReader.status()).toBe('opened')
  currentReader.child.stdin.end('close\n'); await currentReader.exited
  if (access === 'write') {
    const competingWriter = b.launch('write')
    expect(await competingWriter.status()).toBe('SessionAlreadyOwnedError')
    await competingWriter.exited
  }
  first.child.stdin.end('close\n'); await first.exited
  expect(await readFile(b.path)).toEqual(b.bytes)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(persistence, { root: b.root, compression: 'none' })
  await using read = await ctx.sessionPersistence.open(b.id, 'read')
  expect((await read.read()).events).toEqual(oneTurnLog())
}, 30_000)

it('releases migration ownership after process death and retries the complete import', async () => {
  const b = await fixture(), first = b.launch('write', 'pause')
  expect(await first.status()).toBe('reading')
  first.child.kill('SIGKILL'); await first.exited
  const retry = b.launch('write')
  expect(await retry.status()).toBe('opened')
  retry.child.stdin.end('close\n'); await retry.exited
  expect(await readFile(b.path)).toEqual(b.bytes)
}, 30_000)
