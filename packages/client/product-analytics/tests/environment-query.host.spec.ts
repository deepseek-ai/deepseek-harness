import { expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { queryEnvironment } from '../src/environment-query.ts'
import { collectEnvironment } from '../src/environment.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const options = () => ({ timeoutMillis: 5000, maxOutputBytes: 16384, signal: new AbortController().signal })

// These Node snippets are metadata-command stand-ins, with no Cordis or application boot.
it('captures UTF-8 output and closes the child before returning', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "process.stdout.write('CPU 型号')"], options()))
    .toEqual({ kind: 'value', stdout: 'CPU 型号' })
})

it('omits nonzero command output and raw error text', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "console.error('private error'); console.log('private output'); process.exitCode = 1"], options()))
    .toEqual({ kind: 'missing', reason: 'query-failed' })
})

it('settles a failed spawn without retaining an output buffer or child', async () => {
  expect(await queryEnvironment(`${process.execPath}-nonexistent`, [], options()))
    .toEqual({ kind: 'missing', reason: 'query-failed' })
})

it('terminates a timed-out query and awaits close', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options(), timeoutMillis: 20 }))
    .toEqual({ kind: 'missing', reason: 'timeout' })
})

it('bounds multibyte stdout without treating truncated metadata as valid', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "process.stdout.write('界'.repeat(10000))"], { ...options(), maxOutputBytes: 128 }))
    .toEqual({ kind: 'missing', reason: 'output-limit' })
})

it('bounds stderr even when stdout could describe valid metadata', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "process.stderr.write('x'.repeat(10000))"], { ...options(), maxOutputBytes: 128 }))
    .toEqual({ kind: 'missing', reason: 'output-limit' })
})

it('aborts an in-flight query and waits for child closure', async () => {
  const lifetime = new AbortController()
  const result = queryEnvironment(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options(), signal: lifetime.signal })
  lifetime.abort()
  expect(await result).toEqual({ kind: 'missing', reason: 'query-failed' })
})


it('isolates synchronous spawn failures without rejecting or creating a child', async () => {
  const spawn = vi.mocked(childProcess.execFile)
  spawn.mockImplementationOnce(() => {
    throw Object.assign(new Error('private spawn failure'), { code: 'ENOMEM' })
  })
  try {
    expect(await queryEnvironment(process.execPath, [], options())).toEqual({ kind: 'missing', reason: 'query-failed' })
  } finally { spawn.mockClear() }
})


it.runIf(process.platform === 'darwin')('matches the real macOS kernel architecture, including Intel without the arm64 OID', async () => {
  const reference = await queryEnvironment('/usr/sbin/sysctl', ['-i', '-n', 'hw.optional.arm64'], options())
  expect(reference.kind).toBe('value')
  if (reference.kind !== 'value') throw new Error('macOS architecture reference unavailable')
  const snapshot = await collectEnvironment(options())
  expect(snapshot.os_arch).toBe(reference.stdout.trim() === '1' ? 'arm64' : 'x64')
  expect(snapshot.missing_fields).not.toHaveProperty('os_arch')
})
