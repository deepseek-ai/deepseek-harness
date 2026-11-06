/** WSL bridge exit is part of native connection cleanup, independently of protocol EOF. */
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import type { NativeClientConfig } from '@deepseek-ai/dsh-cua/native-client'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { connectWindowsPipe } from '../src/native-transport.ts'

it.each([
  { exitCode: 0, signal: null, joined: true, error: undefined },
  { exitCode: 1, signal: null, joined: true, error: 'exited unsuccessfully' },
  { exitCode: 0, signal: null, joined: false, error: 'did not exit' },
] as const)('joins bridge exit $exitCode with process cleanup $joined', async ({ exitCode, signal, joined, error }) => {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  const handle: SubprocessHandle = { stdin, stdout, stderr: undefined, control: undefined, collected: {},
    done: done.promise, terminate: () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) },
    waitForExit: async () => joined }
  const config: NativeClientConfig = { helperPath: '/fixture.exe', cwd: '/', timeoutMs: 30_000, connectTimeoutMs: 5000,
    screenshotTimeoutMs: 5000, axTimeoutMs: 3000, maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576,
    graceMs: 3000, textEventIntervalMs: 0, maxClickHoldMs: 10_000 }
  const connection = connectWindowsPipe({ spawn: () => handle }, config, 'pipe', 'digest', 'stdio')
  connection.stream.on('error', () => {})
  onTestFinished(() => { connection.stream.destroy(); stdin.destroy(); stdout.destroy() })
  const closing = connection.dispose()
  expect(stdin.writableEnded).toBe(true)
  done.resolve({ exitCode, signal })
  if (error) await expect(closing).rejects.toThrow(error)
  else await closing
})
