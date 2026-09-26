import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { withWindowsSigningStage } from '../scripts/windows-signing-stage.mjs'

const test = it.skipIf(process.platform !== 'win32')

interface StageChild {
  process: ChildProcess
  events: string[]
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  wait: (event: string) => Promise<void>
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(import.meta.dirname, 'stage-test-'))
  const children: StageChild[] = []
  t.onTestFinished(async () => {
    for (const item of children) {
      if (item.process.exitCode === null && item.process.signalCode === null) item.process.kill()
      await item.closed
    }
    await rm(root, { recursive: true, force: true })
  })
  function child(input: string, mode = 'sign'): StageChild {
    const process = fork(join(import.meta.dirname, 'fixtures/windows-signing-stage.mjs'), [root, input, mode], {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const events: string[] = []
    let stderr = ''
    process.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    const waiters = new Map<string, () => void>()
    process.on('message', (message: { type: string }) => { events.push(message.type); waiters.get(message.type)?.() })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      process.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    const failed = new Promise<never>((_resolve, reject) => { process.once('error', reject) })
    const item = { process, events, closed,
      wait: (event: string) => Promise.race([
        events.includes(event) ? Promise.resolve() : new Promise<void>(resolve => waiters.set(event, resolve)),
        closed.then((result) => { throw new Error(`fixture exited before ${event}: ${JSON.stringify(result)} ${stderr}`) }),
        failed,
      ]),
    }
    children.push(item)
    return item
  }
  const first = join(root, 'first.node')
  const second = join(root, 'second.node')
  await writeFile(first, 'original')
  await writeFile(second, 'original')
  return { root, first, second, child }
}

test('independent signing stages wait and recheck the cache before accessing hardware', async (t) => {
  const f = await fixture(t)
  const first = f.child(f.first)
  await first.wait('entered')
  const second = f.child(f.second)
  await second.wait('signing-stage-wait')
  expect(second.events).not.toContain('entered')
  first.process.send('release')
  expect(await first.closed).toEqual({ code: 0, signal: null })
  await second.wait('entered')
  second.process.send('release')
  expect(await second.closed).toEqual({ code: 0, signal: null })
  expect(await readFile(join(f.root, 'hardware-calls'), 'utf8')).toBe('call\n')
  expect(await readFile(f.second, 'utf8')).toBe('signed:original')
  expect(second.events).toContain('signature-cache-hit')
})

test('an interrupted holder releases only the stage lock and retains hardware failure evidence', async (t) => {
  const f = await fixture(t)
  const first = f.child(f.first)
  await first.wait('entered')
  const evidence = join(f.root, 'state/attempt.json')
  await writeFile(evidence, 'retained hardware attempt')
  first.process.kill()
  await first.closed
  await withWindowsSigningStage({ stateDirectory: join(f.root, 'state'), stage: 'inspect', record: () => {} }, async () => {
    expect(await readFile(evidence, 'utf8')).toBe('retained hardware attempt')
  })
})

test('a failed stage releases its handle before another process enters', async (t) => {
  const f = await fixture(t)
  await expect(withWindowsSigningStage({ stateDirectory: join(f.root, 'state'), stage: 'failed', record: () => {} }, async () => {
    throw new Error('stage failed')
  })).rejects.toThrow('stage failed')
  const next = f.child(f.first)
  await next.wait('entered')
  next.process.send('release')
  expect(await next.closed).toEqual({ code: 0, signal: null })
})

test('accepts a state directory whose spelling differs only in Windows path case', async (t) => {
  const f = await fixture(t)
  let entered = false
  await withWindowsSigningStage({ stateDirectory: join(f.root, 'state').toUpperCase(), stage: 'case', record: () => {} }, async () => {
    entered = true
  })
  expect(entered).toBe(true)
})

test('a cancelled waiter never enters and does not release another process lock', async (t) => {
  const f = await fixture(t)
  const holder = f.child(f.first)
  await holder.wait('entered')
  const controller = new AbortController()
  let entered = false
  await expect(withWindowsSigningStage({ stateDirectory: join(f.root, 'state'), stage: 'cancelled', signal: controller.signal,
    record: (event) => { if ('type' in event && event.type === 'signing-stage-wait') controller.abort() },
  }, async () => { entered = true })).rejects.toThrow()
  expect(entered).toBe(false)
  holder.process.send('release')
  expect(await holder.closed).toEqual({ code: 0, signal: null })
})

test('cache clearing waits until another process finishes signing and publishing', async (t) => {
  const f = await fixture(t)
  const signer = f.child(f.first)
  await signer.wait('entered')
  const cleaner = f.child(f.second, 'clear')
  await cleaner.wait('signing-stage-wait')
  expect(cleaner.events).not.toContain('entered')
  signer.process.send('release')
  expect(await signer.closed).toEqual({ code: 0, signal: null })
  await cleaner.wait('entered')
  cleaner.process.send('release')
  expect(await cleaner.closed).toEqual({ code: 0, signal: null })
  expect(await readdir(join(f.root, 'cache'))).toEqual([])
  expect(await readFile(f.first, 'utf8')).toBe('signed:original')
})
