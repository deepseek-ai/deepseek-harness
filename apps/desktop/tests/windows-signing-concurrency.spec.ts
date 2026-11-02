/** Driver ownership tests replace every native signing and device boundary. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runWindowsSigningConcurrencyExperiment } from './windows-signing-concurrency.perf.ts'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { createPackagingRun } from '../scripts/packaging-run.mjs'
import { beginWindowsSigningAttempt } from '../scripts/windows-signing-state.mjs'
import { inspectWindowsTokenIdentity } from '../scripts/windows-token-identity.ts'
import { prepareSigningCorpus } from './helpers/windows-signing-corpus.ts'

const state = vi.hoisted(() => ({
  root: '', environment: {} as NodeJS.ProcessEnv,
  identity: 'matched', failure: '' as '' | 'primary' | 'final' | 'audit',
  signed: new Set<string>(), completed: new Set<string>(), stages: [] as string[],
  events: [] as object[], successes: 0, failures: 0,
  removals: [] as { executable: string; args: readonly string[]; environment: NodeJS.ProcessEnv }[],
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(() => { throw new Error('Native subprocesses are forbidden in driver tests') }),
}))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.root }))
vi.mock('node:crypto', async original => ({
  ...await original<typeof import('node:crypto')>(),
  X509Certificate: class {
    fingerprint = 'A'.repeat(40)
    validFrom = 'Jan 1 2000 GMT'
    validTo = 'Jan 1 2100 GMT'
  },
}))
vi.mock('../scripts/desktop-package-environment.mjs', () => ({
  loadDesktopPackageEnvironment: vi.fn(() => state.environment),
}))
vi.mock('../scripts/windows-sign.mjs', async original => ({
  ...await original<typeof import('../scripts/windows-sign.mjs')>(),
  createWindowsTokenSigner: vi.fn(() => { throw new Error('unconfigured constructor') }),
}))
vi.mock('../scripts/windows-token-identity.ts', () => ({
  inspectWindowsTokenIdentity: vi.fn(async () => state.identity),
  windowsTokenIdentityFailure: (result: string) => `Identity refused: ${result}`,
}))
vi.mock('./helpers/windows-signing-corpus.ts', () => ({
  prepareSigningCorpus: vi.fn(async () => {
    const files = []
    for (let index = 0; index < 6; index++) {
      const path = join(state.root, `real-${index}.dll`)
      await writeFile(path, 'inert real file')
      files.push({ path, bytes: 15, sha256: 'a'.repeat(64) })
    }
    return files
  }),
}))
vi.mock('../scripts/windows-signing-stage.mjs', () => ({
  withWindowsSigningStage: vi.fn(async (_options: object, operation: () => Promise<void>) => operation()),
}))
vi.mock('../scripts/packaging-run.mjs', () => ({
  createPackagingRun: vi.fn(() => ({
    directory: join(state.root, 'run'),
    finish: vi.fn(),
    run: vi.fn(async (stage: string, executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      state.stages.push(stage)
      if (stage.startsWith('compile-')) {
        await writeFile(args.find(arg => arg.startsWith('/out:'))!.slice(5), 'inert probe')
      } else if (stage.startsWith('remove-signature-')) {
        state.removals.push({ executable, args, environment: options.env })
      } else {
        state.signed.add(options.env.DSH_DESKTOP_WINDOWS_SIGN_TARGET!)
      }
    }),
  })),
  recordPackagingEvent: (_directory: string, event: object) => {
    if (state.failure === 'audit' && 'type' in event && event.type === 'experiment-file-verified') throw new Error('Audit failed')
    state.events.push(event)
  },
}))
vi.mock('../scripts/windows-signing-state.mjs', () => ({
  beginWindowsSigningAttempt: vi.fn((options: { runDirectory: string; target: string; stateDirectory?: string }) => {
    expect(options.stateDirectory).toBeUndefined()
    const lock = join(state.root, '.dsh-desktop-signing', 'attempt.json')
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, 'batch attempt', { flag: 'wx' })
    return {
      success: () => {
        const verified = state.events.filter(event => 'type' in event && event.type === 'experiment-file-verified'
          && 'path' in event && typeof event.path === 'string' && dirname(event.path) === options.target)
        expect(verified).toHaveLength(6)
        expect(readFileSync(join(options.runDirectory, 'measurements.json'), 'utf8')).toContain('"files": 6')
        unlinkSync(lock)
        state.successes++
      },
      failure: () => { state.failures++ },
    }
  }),
}))
vi.mock('../scripts/windows-runtime-signature.mjs', () => ({
  inspectWindowsRuntimeSignature: vi.fn(async (path: string) => {
    if (!state.signed.has(path)) return { status: 'NotSigned', timestamped: false, thumbprint: null }
    const timestamped = state.completed.has(path)
    const failed = state.failure === (timestamped ? 'final' : 'primary')
    return { status: failed ? 'HashMismatch' : 'Valid', timestamped, thumbprint: 'A'.repeat(40) }
  }),
}))
vi.mock('../scripts/windows-timestamp.mjs', () => ({
  completeWindowsSignature: vi.fn(async (path: string, options: { sign: (path: string) => Promise<void> }) => {
    await options.sign(path)
    state.completed.add(path)
  }),
  normalizeWindowsSignature: vi.fn(() => { throw new Error('Native normalization is forbidden in driver tests') }),
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(async () => {
  vi.clearAllMocks()
  state.root = await mkdtemp(join(tmpdir(), 'signing-driver-'))
  mkdirSync(join(state.root, 'run'))
  state.identity = 'matched'; state.failure = ''; state.successes = 0; state.failures = 0
  state.signed.clear(); state.completed.clear(); state.stages = []; state.events = []; state.removals = []
  state.environment = {
    DSH_DESKTOP_WINDOWS_CER_FILE: join(state.root, 'certificate.cer'),
    DSH_DESKTOP_WINDOWS_SIGNTOOL: 'forbidden-signer', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin',
    DSH_DESKTOP_WINDOWS_KEY_CONTAINER: '  fixture-container  ', API_KEY: 'fixture-secret', NODE_OPTIONS: 'forbidden-option',
  }
  await writeFile(state.environment.DSH_DESKTOP_WINDOWS_CER_FILE!, 'inert certificate')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  const { createWindowsTokenSigner } = await import('../scripts/windows-sign.mjs')
  vi.mocked(createWindowsTokenSigner).mockReturnValue(vi.fn(async () => { throw new Error('Production signer is forbidden') }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(state.root, { recursive: true, force: true, maxRetries: 3 })
})

const execute = () => runWindowsSigningConcurrencyExperiment(['--execute', '--config-root', state.root, '--rounds', '1'])
const lock = () => join(state.root, '.dsh-desktop-signing', 'attempt.json')

it('requires opt-in before reading configuration or querying a device', async () => {
  await runWindowsSigningConcurrencyExperiment([])
  expect(loadDesktopPackageEnvironment).not.toHaveBeenCalled()
  expect(inspectWindowsTokenIdentity).not.toHaveBeenCalled()
  expect(createPackagingRun).not.toHaveBeenCalled()
})

it.each(['1999-01-01', '2101-01-01'])('rejects certificate validity at %s before querying or signing', async (date) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date))
  await expect(execute()).rejects.toThrow('currently valid')
  expect(inspectWindowsTokenIdentity).not.toHaveBeenCalled()
  expect(beginWindowsSigningAttempt).not.toHaveBeenCalled()
  expect(state.stages).toEqual([])
})

it.each(['certificate-mismatch', 'provider-unavailable', 'container-unavailable', 'unknown'])('refuses public identity %s before any signing', async (identity) => {
  state.identity = identity
  await expect(execute()).rejects.toThrow('Identity refused')
  expect(state.stages).toEqual([])
  expect(beginWindowsSigningAttempt).not.toHaveBeenCalled()
})

it('retains an existing default-account interlock without accessing the device', async () => {
  mkdirSync(dirname(lock()), { recursive: true }); writeFileSync(lock(), 'prior failure')
  await expect(execute()).rejects.toThrow('Retained signing interlock')
  expect(inspectWindowsTokenIdentity).not.toHaveBeenCalled()
  expect(readFileSync(lock(), 'utf8')).toBe('prior failure')
})

it('completes all three modes and releases each default-account batch only after recording every verification', async () => {
  await execute()
  expect(state.successes).toBe(3)
  expect(state.failures).toBe(0)
  expect(state.signed.size).toBe(18)
  expect(existsSync(lock())).toBe(false)
  expect(beginWindowsSigningAttempt).toHaveBeenCalledTimes(3)
  expect(inspectWindowsTokenIdentity).toHaveBeenCalledWith(expect.objectContaining({
    container: 'fixture-container', environment: {},
  }))
  expect(JSON.stringify(state.events)).not.toMatch(/fixture-pin|fixture-secret|fixture-container/u)
})

it('uses fresh real-file copies for 1, 2, 4 workers and reverses the second round', async () => {
  await runWindowsSigningConcurrencyExperiment(['--execute', '--config-root', state.root, '--corpus', join(state.root, 'manifest.json')])
  expect(state.successes).toBe(6)
  expect(state.signed.size).toBe(36)
  expect(state.stages.some(stage => stage.startsWith('compile-'))).toBe(false)
  expect(prepareSigningCorpus).toHaveBeenCalledOnce()
  expect(state.events.filter(event => 'type' in event && event.type === 'experiment-batch-plan')).toEqual([
    expect.objectContaining({ round: 1, jobs: 1, hardwareConcurrency: 1 }),
    expect.objectContaining({ round: 1, jobs: 2, hardwareConcurrency: 2 }),
    expect.objectContaining({ round: 1, jobs: 4, hardwareConcurrency: 4 }),
    expect.objectContaining({ round: 2, jobs: 4, hardwareConcurrency: 4 }),
    expect.objectContaining({ round: 2, jobs: 2, hardwareConcurrency: 2 }),
    expect.objectContaining({ round: 2, jobs: 1, hardwareConcurrency: 1 }),
  ])
  expect(existsSync(lock())).toBe(false)
})

it('offers a separate four-job control with only one hardware request', async () => {
  await runWindowsSigningConcurrencyExperiment(['--execute', '--config-root', state.root, '--rounds', '1', '--corpus', join(state.root, 'manifest.json'), '--pipeline-control'])
  expect(state.successes).toBe(1)
  expect(state.events).toContainEqual(expect.objectContaining({ type: 'experiment-batch-plan', jobs: 4, hardwareConcurrency: 1 }))
})

it('refuses corpus preparation failure before beginning a hardware attempt', async () => {
  vi.mocked(prepareSigningCorpus).mockRejectedValueOnce(new Error('changed input'))
  await expect(runWindowsSigningConcurrencyExperiment(['--execute', '--config-root', state.root, '--corpus', join(state.root, 'manifest.json')])).rejects.toThrow('changed input')
  expect(beginWindowsSigningAttempt).not.toHaveBeenCalled()
  expect(state.signed.size).toBe(0)
})

it('uses the stripping override only for public removal on a corpus copy', async () => {
  const copy = join(state.root, 'copy.exe')
  const stripTool = join(state.root, 'sdk-signtool.exe')
  vi.mocked(prepareSigningCorpus).mockImplementationOnce(async (_manifest, _directory, remove) => {
    await remove(copy)
    throw new Error('stop before hardware')
  })
  await expect(runWindowsSigningConcurrencyExperiment(['--execute', '--config-root', state.root, '--corpus', join(state.root, 'manifest.json'), '--strip-tool', stripTool])).rejects.toThrow('stop before hardware')
  expect(state.removals).toEqual([{ executable: stripTool, args: ['remove', '/s', copy], environment: {} }])
  expect(beginWindowsSigningAttempt).not.toHaveBeenCalled()
})

it.each(['primary', 'final', 'audit'] as const)('retains the batch interlock and stops later modes after %s failure', async (failure) => {
  state.failure = failure
  await expect(execute()).rejects.toThrow(failure === 'audit' ? 'Audit failed' : 'signature verification failed')
  expect(state.successes).toBe(0)
  expect(state.failures).toBe(1)
  expect(beginWindowsSigningAttempt).toHaveBeenCalledOnce()
  expect(state.signed.size).toBe(1)
  expect(existsSync(lock())).toBe(true)
  expect(state.stages.some(stage => stage.includes('pipeline') || stage.includes('hardware2'))).toBe(false)
})
