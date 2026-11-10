/** WSL bridge exit is part of native connection cleanup, independently of protocol EOF. */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import type { NativeClientConfig } from '@deepseek-ai/dsh-cua/native-client'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { connectWindowsPipe } from '../src/native-transport.ts'

const config: NativeClientConfig = { helperPath: '/fixture.exe', cwd: '/', timeoutMs: 30_000, connectTimeoutMs: 5000,
  screenshotTimeoutMs: 5000, axTimeoutMs: 3000, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576,
  graceMs: 3000, textEventIntervalMs: 0, maxClickHoldMs: 10_000 }

function bridge(joined = true, graceMs = config.graceMs) {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  const handle: SubprocessHandle = { stdin, stdout, stderr: undefined, control: undefined, collected: {},
    done: done.promise, terminate: () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    waitForExit: async () => joined }
  const connection = connectWindowsPipe({ spawn: () => handle }, { ...config, graceMs }, 'pipe', 'digest', 'stdio')
  connection.stream.on('error', () => {})
  onTestFinished(() => { connection.stream.destroy(); stdin.destroy(); stdout.destroy() })
  return { connection, stdin, done }
}

it.each([
  { exitCode: 0, signal: null, joined: true, error: undefined },
  { exitCode: 1, signal: null, joined: true, error: 'exited unsuccessfully' },
  { exitCode: 0, signal: null, joined: false, error: 'did not exit' },
] as const)('joins bridge exit $exitCode with process cleanup $joined', async ({ exitCode, signal, joined, error }) => {
  const { connection, stdin, done } = bridge(joined)
  const closing = connection.dispose()
  expect(stdin.writableEnded).toBe(true)
  done.resolve({ exitCode, signal })
  if (error) await expect(closing).rejects.toThrow(error)
  else await closing
})

it('reports a missing native pipe before a connection is admitted', async () => {
  const id = randomUUID()
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), id)
  const connection = connectWindowsPipe({ spawn: () => { throw new Error('unexpected bridge') } }, config, endpoint, 'digest', 'pipe')
  const closed = new Promise<void>(resolve => connection.stream.once('close', resolve))
  await expect(connection.connected).rejects.toMatchObject({ code: 'ENOENT' })
  await closed
  await connection.dispose()
})

it.each([new Error('bridge stopped'), 'bridge stopped'])('reports a rejected bridge process on the stream', async (reason) => {
  const { connection, done } = bridge()
  const failed = new Promise<Error>(resolve => connection.stream.once('error', resolve))
  done.reject(reason)
  const error = await failed
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toBe('bridge stopped')
  await expect(connection.dispose()).rejects.toBe(reason)
})

it('terminates a bridge that stays alive after stdin closes', async () => {
  const { connection, stdin } = bridge(true, 5)
  const closing = connection.dispose()
  expect(stdin.writableEnded).toBe(true)
  await expect(closing).rejects.toThrow('SIGTERM')
})
