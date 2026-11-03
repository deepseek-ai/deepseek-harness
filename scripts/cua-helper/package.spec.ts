/** Helper packaging retains redacted Apple failures independently of desktop installer startup. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', directory: '', requestedRoot: '', reject: false }))
vi.mock('../../apps/desktop/scripts/desktop-package-environment.mjs', () => ({
  loadDesktopPackageEnvironment: () => ({ APPLE_ID: 'private@example.test', APPLE_PASSWORD: 'secret-sentinel' }),
}))
vi.mock('../../apps/desktop/scripts/desktop-release-environment.mjs', () => ({
  resolveMacOSSigningEnvironment: () => ({ signingIdentity: 'Fixture (ABCDEFGHIJ)', teamId: 'ABCDEFGHIJ' }),
  resolveMacOSNotarizationEnvironment: () => ({ appleId: 'private@example.test', appleIdPassword: 'secret-sentinel', appleTeamId: 'ABCDEFGHIJ' }),
}))
vi.mock('../../apps/desktop/scripts/macos-package-settings.mjs', () => ({ resolveMacOSPackageSettings: () => ({}) }))
vi.mock('../../apps/desktop/scripts/macos-signing-keychain.mjs', () => ({
  withMacOSSigningKeychain: async (environment: object, action: (environment: object) => Promise<void>) => action(environment),
}))
vi.mock('../../apps/desktop/scripts/macos-notarization-proxy.ts', () => ({
  withMacOSNotarizationProxy: async (_settings: object, action: () => Promise<void>) => action(),
}))
vi.mock('../../apps/desktop/scripts/verify-macos-signature.mjs', () => ({ verifyMacOSRuntimeCode: () => {} }))
vi.mock('../../apps/desktop/scripts/packaging-run.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../apps/desktop/scripts/packaging-run.mjs')>()
  return { ...original, createPackagingRun: (...args: Parameters<typeof original.createPackagingRun>) => {
    state.requestedRoot = args[0]
    const run = original.createPackagingRun(join(state.root, 'records'), args[1], args[2])
    state.directory = run.directory
    return run
  } }
})
vi.mock('../../apps/desktop/scripts/notarize-macos.mjs', () => ({
  notarizeMacOS: async () => {
    const { runLoggedNotarytool } = await import('../../apps/desktop/scripts/logged-notarytool.mjs')
    const id = '11111111-2222-3333-4444-555555555555'
    await runLoggedNotarytool(['submit', '/fixture/helper.zip', '--apple-id', 'private@example.test',
      '--password', 'secret-sentinel', '--wait', '--output-format', 'json'], process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, async (args) => {
      if (state.reject) throw new Error('Apple transport failed: private@example.test secret-sentinel')
      return JSON.stringify(args[0] === 'submit' ? { id } : { id, status: 'Accepted' })
    })
  },
}))
vi.mock('execa', () => ({ execa: async (_command: string, args: string[]) => {
  const output = args.indexOf('--output-directory')
  if (output !== -1) await mkdir(args[output + 1]!, { recursive: true })
} }))
vi.mock('tar', () => ({
  create: async ({ file }: { file: string }) => writeFile(file, 'fixture archive'),
  extract: async () => {},
}))
vi.mock('./payload.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./payload.ts')>(),
  readCuaApplication: (directory: string) => ({ application: join(directory, 'fixture/DSH Computer Use.app') }),
  sealCuaApplication: () => 'fixture',
  verifyCuaHelperPayload: () => {},
}))

it.each([false, true])('retains helper packaging outcome and restores the inherited journal when Apple rejects=%s', async (reject) => {
  state.root = await mkdtemp(join(tmpdir(), 'cua-package-log-'))
  state.directory = ''
  state.reject = reject
  const output = join(state.root, 'output')
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedArgv = process.argv
  const savedDirectory = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  const inherited = reject ? join(state.root, 'outer-record') : undefined
  const listeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
  try {
    Object.defineProperty(process, 'platform', { ...savedPlatform, value: 'darwin' })
    process.argv = [process.execPath, resolve('scripts/cua-helper/package.ts'), '--out', output]
    if (inherited === undefined) delete process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
    else process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = inherited
    vi.resetModules()
    const work = import('./package.ts')
    if (reject) await expect(work).rejects.toThrow('CUA helper packaging failed; see')
    else {
      try { await work } catch (error) {
        throw new Error(stderr.mock.calls.map(([chunk]) => String(chunk)).join(''), { cause: error })
      }
    }
    expect(state.requestedRoot).toBe(resolve('apps/desktop/.desktop-build/packaging-runs'))
    expect(state.directory).not.toBe('')
    const events = await readFile(join(state.directory, 'events.jsonl'), 'utf8')
    const result = await readFile(join(state.directory, 'result.json'), 'utf8')
    const terminal = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(JSON.parse(result)).toMatchObject({ success: !reject })
    expect(events).toContain('notarytool:upload:helper.zip')
    for (const diagnostic of [events, result, terminal]) {
      expect(diagnostic).not.toContain('private@example.test')
      expect(diagnostic).not.toContain('secret-sentinel')
    }
    if (reject) {
      expect(events).toContain('Apple transport failed: [REDACTED] [REDACTED]')
      expect(terminal).toContain('Apple transport failed: [REDACTED] [REDACTED]')
      expect(events).not.toContain('notarytool:wait')
      await expect(stat(join(output, 'cua-helper.tgz'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(events).toContain('"status":"Accepted"')
      expect(await readFile(join(output, 'cua-helper.tgz'), 'utf8')).toBe('fixture archive')
    }
    expect(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR).toBe(inherited)
    expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(listeners)
  } finally {
    Object.defineProperty(process, 'platform', savedPlatform)
    process.argv = savedArgv
    if (savedDirectory === undefined) delete process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
    else process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = savedDirectory
    stderr.mockRestore()
    consoleLog.mockRestore()
    await rm(state.root, { recursive: true, force: true })
  }
})
