/** Stream framing, early termination and process ownership for packaged rg. */
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { readRipgrepLines, resolveRgPath, spawnRipgrep } from '../src/index.ts'

function handle(
  stdout: Readable | undefined,
  done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode: 0, signal: null }),
) {
  return { stdout, stdin: undefined, stderr: undefined, control: undefined, collected: {}, done,
    terminate: vi.fn(), waitForExit: vi.fn(async () => true) } satisfies SubprocessHandle
}

describe('packaged rg spawning', () => {
  it('forwards explicit settings and prepends --no-config', async () => {
    const child = handle(undefined)
    const spawn = vi.fn(() => child)
    const spec: SubprocessSpawnSpec = { argv: ['--files'], cwd: '/workspace', signal: new AbortController().signal,
      graceMs: 5, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 20 } }, env: { TEST: 'value' } }
    await expect(spawnRipgrep({ spawn }, spec)).resolves.toBe(child)
    expect(spawn).toHaveBeenCalledWith({ ...spec, argv: [await resolveRgPath(), '--no-config', '--files'] })
  })

  it('preserves synchronous provider failures', async () => {
    const failure = new Error('cannot spawn')
    await expect(spawnRipgrep({ spawn() { throw failure } }, { argv: [], cwd: '/', graceMs: 1,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })).rejects.toBe(failure)
  })
})

describe('incremental stdout records', () => {
  it('decodes split UTF-8 and delimiter chunks, including an unterminated final record', async () => {
    const bytes = Buffer.from('雪\0two\0tail')
    const child = handle(Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]))
    const lines: string[] = []
    expect(await readRipgrepLines(child, '\0', (line) => { lines.push(line); return true })).toEqual({ stopped: false, outcome: { exitCode: 0, signal: null } })
    expect(lines).toEqual(['雪', 'two', 'tail'])
    expect(child.terminate).not.toHaveBeenCalled()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('stops callbacks at the cap while draining subsequent buffered chunks', async () => {
    const child = handle(Readable.from(['one\ntwo\n', 'three\n']))
    const onLine = vi.fn(() => false)
    expect((await readRipgrepLines(child, '\n', onLine)).stopped).toBe(true)
    expect(onLine).toHaveBeenCalledExactlyOnceWith('one')
    expect(child.terminate).toHaveBeenCalledOnce()
  })

  it('accepts an empty stream and can stop at the final unterminated record', async () => {
    const empty = handle(Readable.from([]))
    const onLine = vi.fn(() => true)
    expect((await readRipgrepLines(empty, '\n', onLine)).stopped).toBe(false)
    expect(onLine).not.toHaveBeenCalled()
    const child = handle(Readable.from(['last']))
    expect((await readRipgrepLines(child, '\n', () => false)).stopped).toBe(true)
    expect(child.terminate).toHaveBeenCalledOnce()
  })

  it('terminates a handle without piped stdout and waits for its outcome', async () => {
    const child = handle(undefined, Promise.reject(new Error('launch failure')))
    await expect(readRipgrepLines(child, '\n', () => true)).rejects.toThrow('requires piped stdout')
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('propagates callback failures after terminating and awaiting cleanup', async () => {
    const child = handle(Readable.from(['line\n']))
    const failure = new Error('consumer failed')
    await expect(readRipgrepLines(child, '\n', () => { throw failure })).rejects.toBe(failure)
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('settles a provider failure even if stdout stays open', async () => {
    const stdout = new PassThrough()
    const failure = new Error('provider failed')
    const child = handle(stdout, Promise.reject(failure))
    await expect(readRipgrepLines(child, '\n', () => true)).rejects.toBe(failure)
    expect(stdout.destroyed).toBe(true)
    expect(child.terminate).toHaveBeenCalledOnce()
  })

  it('waits for the managed process range after stdout and the outcome finish', async () => {
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => { release = resolve })
    const entered = Promise.withResolvers<undefined>()
    const child = { ...handle(Readable.from(['line\n'])),
      waitForExit: async () => { entered.resolve(undefined); await cleanup; return true } }
    let settled = false
    const result = readRipgrepLines(child, '\n', () => true).then((value) => { settled = true; return value })
    await entered.promise
    expect(settled).toBe(false)
    release()
    await result
    expect(settled).toBe(true)
  })
})
