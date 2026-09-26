import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPackagingRun } from '../scripts/packaging-run.mjs'
import { preflightWindowsSigning } from '../scripts/windows-signing-preflight.ts'
import { inspectWindowsRuntimeSignature } from '../scripts/windows-runtime-signature.mjs'

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  X509Certificate: class {
    ca = false
    keyUsage = ['1.3.6.1.5.5.7.3.3']
    fingerprint = 'A'.repeat(40)
    validFrom = 'Jan 1 2000 GMT'
    validTo = 'Jan 1 2100 GMT'
  },
}))

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['1999-01-01', '2101-01-01'])('rejects a certificate outside its validity period at %s', async (date) => {
  const options = await fixture()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(date))
  await expect(preflightWindowsSigning(options)).rejects.toThrow('currently valid')
  expect(options.compile).not.toHaveBeenCalled()
  expect(options.sign).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'win32')('compiles a real unsigned probe without executing it or accessing a token', async () => {
  const { compile: _compile, ...options } = await fixture()
  options.environment.SystemRoot = process.env.SystemRoot!
  options.inspect.mockImplementation(async (path: string) => options.sign.mock.calls.length === 0
    ? inspectWindowsRuntimeSignature(path)
    : { status: 'Valid', timestamped: true, thumbprint: 'A'.repeat(40) })
  await preflightWindowsSigning(options)
  const bytes = await readFile(join(options.runDirectory, 'signing-preflight/probe.exe'))
  expect(bytes.subarray(0, 2).toString()).toBe('MZ')
  expect(bytes.length).toBeLessThan(16 * 1024)
  expect(options.sign).toHaveBeenCalledOnce()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'signing-preflight-'))
  roots.push(root)
  const run = createPackagingRun(join(root, 'records'), {})
  const compiler = join(root, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  await mkdir(dirname(compiler), { recursive: true })
  await writeFile(compiler, 'inert compiler')
  const environment = { SystemRoot: root,
    DSH_DESKTOP_WINDOWS_CER_FILE: join(root, 'public.cer'),
    DSH_DESKTOP_WINDOWS_SIGNTOOL: join(root, 'signtool.exe'),
    DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'fixture-container', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin' }
  await writeFile(environment.DSH_DESKTOP_WINDOWS_CER_FILE, 'inert certificate')
  await writeFile(environment.DSH_DESKTOP_WINDOWS_SIGNTOOL, 'inert signer')
  const sequence: string[] = []
  const compile = vi.fn(async (_compiler: string, _source: string, output: string) => {
    sequence.push('compile'); await writeFile(output, 'inert unsigned probe')
  })
  const sign = vi.fn(async () => { sequence.push('sign') })
  const inspect = vi.fn(async (_path: string) => {
    sequence.push('inspect')
    return sign.mock.calls.length === 0
      ? { status: 'NotSigned', timestamped: false, thumbprint: null }
      : { status: 'Valid', timestamped: true, thumbprint: 'A'.repeat(40) }
  })
  return { root, compiler, sequence, runDirectory: run.directory, environment, stateDirectory: join(root, 'state'), compile, sign, inspect }
}

it('compiles one new probe and verifies one production-format signature before success', async () => {
  const options = await fixture()
  await preflightWindowsSigning(options)
  expect(options.sequence).toEqual(['compile', 'inspect', 'sign', 'inspect'])
  expect(options.sign).toHaveBeenCalledExactlyOnceWith({ path: join(options.runDirectory, 'signing-preflight/probe.exe'), hash: 'sha256', isNest: false })
  const events = await readFile(join(options.runDirectory, 'events.jsonl'), 'utf8')
  expect(events).toContain('signing-preflight-success')
  expect(events).toContain('"probeExecuted":false')
  expect(events).not.toContain('fixture-pin')
})

it.each(['interlock', 'fatal', 'compiler', 'certificate', 'signTool', 'pin', 'audit'] as const)
('rejects static %s failure without compiling or signing', async (failure) => {
  const options = await fixture()
  if (failure === 'interlock') {
    await mkdir(options.stateDirectory)
    await writeFile(join(options.stateDirectory, 'attempt.json'), 'retained attempt')
  } else if (failure === 'fatal') await writeFile(join(options.runDirectory, 'fatal.json'), 'failed')
  else if (failure === 'compiler') await rm(options.compiler)
  else if (failure === 'certificate') await rm(options.environment.DSH_DESKTOP_WINDOWS_CER_FILE)
  else if (failure === 'signTool') await rm(options.environment.DSH_DESKTOP_WINDOWS_SIGNTOOL)
  else if (failure === 'pin') options.environment.DSH_DESKTOP_WINDOWS_TOKEN_PIN = ''
  else {
    await rm(join(options.runDirectory, 'events.jsonl'))
    await mkdir(join(options.runDirectory, 'events.jsonl'))
  }
  await expect(preflightWindowsSigning(options)).rejects.toThrow()
  expect(options.compile).not.toHaveBeenCalled()
  expect(options.sign).not.toHaveBeenCalled()
  if (failure === 'interlock') expect(await readFile(join(options.stateDirectory, 'attempt.json'), 'utf8')).toBe('retained attempt')
})

it.each(['compile', 'unexpected-signature', 'sign', 'timestamp', 'publisher', 'verification'] as const)
('stops on %s failure without retry or successful evidence', async (failure) => {
  const options = await fixture()
  if (failure === 'compile') options.compile.mockRejectedValueOnce(new Error('compiler refused'))
  else if (failure === 'unexpected-signature') options.inspect.mockResolvedValueOnce({ status: 'Valid', timestamped: true, thumbprint: 'A'.repeat(40) })
  else if (failure === 'sign') options.sign.mockRejectedValueOnce(new Error('token refused'))
  else options.inspect.mockResolvedValueOnce({ status: 'NotSigned', timestamped: false, thumbprint: null })
    .mockResolvedValueOnce({ status: failure === 'verification' ? 'HashMismatch' : 'Valid',
      timestamped: failure !== 'timestamp', thumbprint: (failure === 'publisher' ? 'B' : 'A').repeat(40) })
  await expect(preflightWindowsSigning(options)).rejects.toThrow()
  expect(options.sign).toHaveBeenCalledTimes(failure === 'compile' || failure === 'unexpected-signature' ? 0 : 1)
  expect(await readFile(join(options.runDirectory, 'events.jsonl'), 'utf8')).not.toContain('signing-preflight-success')
})
