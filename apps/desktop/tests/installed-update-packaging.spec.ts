import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { assertInstalledUpdateSigningClear, installedUpdatePackagingEnvironment, packageInstalledUpdate } from '../scripts/installed-update-packaging.ts'

const state = vi.hoisted(() => ({ home: '', settings: {} as NodeJS.ProcessEnv, loads: 0,
  sourceCommit: 'a'.repeat(40), dirtyFiles: '' }))
// Other test processes create workspace probes; only this fixture controls its recorded Git inputs.
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    if (args[0] !== 'git') return actual.execFileSync(...args)
    const command = args[1]?.join(' ')
    if (command === 'rev-parse HEAD') return state.sourceCommit
    if (command === 'status --porcelain=v1 --untracked-files=normal') return state.dirtyFiles
    throw new Error(`unexpected fixture Git command: ${String(command)}`)
  } }
})
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }))
vi.mock('../scripts/desktop-package-environment.mjs', () => ({
  loadDesktopPackageEnvironment: () => { state.loads++; return state.settings },
  validateDesktopPackageEnvironment: () => undefined,
}))
vi.mock('../scripts/installed-update-builder.ts', () => ({ createInstalledUpdateBuilderConfig: async () => ({}) }))
vi.mock('../scripts/packaging-run.mjs', async (original) => {
  const actual = await original<typeof import('../scripts/packaging-run.mjs')>()
  return { ...actual, createPackagingRun: (...args: Parameters<typeof actual.createPackagingRun>) => {
    const record = actual.createPackagingRun(...args)
    return { ...record, run: (stage: string, executable: string, argv: readonly string[], options: {
      cwd: string
      env: NodeJS.ProcessEnv
      timeoutMs?: number
    }) => record.run(stage, executable,
      [resolve(import.meta.dirname, 'fixtures/installed-update-packaging.mjs'), ...argv.slice(-2)], options) }
  } }
})

const versions = ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'] as const

async function fixture(body: (manifest: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-packaging-entry-'))
  const previous = { ...state }
  try {
    state.home = root
    state.loads = 0
    const run = await createInstalledUpdateRun(root, versions, { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] })
    const certificate = join(root, 'certificate.cer')
    const tool = join(root, 'signtool.exe')
    await writeFile(certificate, 'inert public certificate fixture')
    await writeFile(tool, 'inert unused signer fixture')
    await mkdir(join(run.root, 'application'))
    await writeFile(join(run.root, 'application/result.json'), '{}')
    await mkdir(join(run.root, versions[0], 'dsh'), { recursive: true })
    await writeFile(join(run.root, versions[0], 'dsh/desktop-runtime.json'), '{}')
    state.settings = { ...Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$/iu.test(name))),
    DSH_DESKTOP_WINDOWS_CER_FILE: certificate, DSH_DESKTOP_WINDOWS_SIGNTOOL: tool,
    DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-secret-pin', DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'fixture-container' }
    await body(join(run.root, 'run.json'), root)
  } finally { Object.assign(state, previous); await rm(root, { recursive: true, force: true }) }
}

describe('operator-driven packaging entry', () => {
  it('refuses the interlock before loading credentials, confirmation, or child allocation and preserves it byte-for-byte', async () => {
    await fixture(async (manifest, root) => {
      const lock = join(root, '.dsh-desktop-signing/attempt.json')
      await mkdir(join(root, '.dsh-desktop-signing'))
      await writeFile(lock, 'retained incident record')
      const confirm = vi.fn(async () => true)
      await expect(packageInstalledUpdate(manifest, versions[0], { execute: true, confirm })).rejects.toThrow('interlock exists')
      expect(state.loads).toBe(0)
      expect(confirm).not.toHaveBeenCalled()
      expect(await readFile(lock, 'utf8')).toBe('retained incident record')
      expect(await readdir(join(manifest, '..', versions[0]))).toEqual(['dsh'])
      await expect(assertInstalledUpdateSigningClear(lock)).rejects.toThrow('interlock exists')
    })
  })

  it('strips unrelated secrets and preload overrides while retaining signing inputs and the Windows archive filter', () => {
    expect(installedUpdatePackagingEnvironment({ DSH_DESKTOP_TARGET_PLATFORM: 'win32', PATH: 'tool-path',
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'pin', DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'container',
      DEEPSEEK_API_KEY: 'llm', DOWNLOAD_TEST_COS_SECRET_KEY: 'cos', NODE_OPTIONS: 'preload', NODE_PATH: 'injected' }))
      .toEqual({ DSH_DESKTOP_TARGET_PLATFORM: 'win32', PATH: 'tool-path', DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'pin',
        DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'container', DSH_DESKTOP_UNSIGNED: '0', ELECTRON_BUILDER_7Z_FILTER: 'BCJ' })
  })

  it('checks without confirmation or allocating a packaging directory', async () => {
    await fixture(async (manifest) => {
      const confirm = vi.fn(async () => true)
      expect(await packageInstalledUpdate(manifest, versions[0], { execute: false, confirm }))
        .toMatchObject({ mode: 'check', childLaunched: false, signed: false })
      expect(confirm).not.toHaveBeenCalled()
      expect(await readdir(join(manifest, '..', versions[0]))).toEqual(['dsh'])
    })
  })

  it.runIf(process.platform === 'win32' && process.arch === 'x64').each([true, false])(
    'supervises an inert child with failure=%s, retains redaction and refuses reuse', async (failure) => {
      await fixture(async (manifest) => {
        state.settings.DSH_TEST_PACKAGING_FAIL = failure ? '1' : '0'
        const result = packageInstalledUpdate(manifest, versions[0], { execute: true, confirm: async () => true })
        if (failure) await expect(result).rejects.toThrow('signed-installer failed')
        else expect(await result).toMatchObject({ builderCompleted: true, packageVerification: 'pending', published: false })
        const parent = join(manifest, '..', versions[0], 'packaging')
        const record = join(parent, (await readdir(parent))[0]!)
        expect(await readFile(join(record, 'stdout.log'), 'utf8')).toBe('[REDACTED]')
        expect(JSON.parse(await readFile(join(record, 'result.json'), 'utf8'))).toMatchObject({ success: !failure })
        const events = await readFile(join(record, 'events.jsonl'), 'utf8')
        expect(events.match(/stage-spawn/gu)).toHaveLength(1)
        expect(events).toContain('"timedOut":false')
        const confirm = vi.fn(async () => true)
        await expect(packageInstalledUpdate(manifest, versions[0], { execute: true, confirm })).rejects.toThrow('existing packaging')
        expect(confirm).not.toHaveBeenCalled()
      })
    },
  )

  it.runIf(process.platform === 'win32' && process.arch === 'x64')('does not allocate a build after declined confirmation or an intervening interlock', async () => {
    await fixture(async (manifest, root) => {
      await expect(packageInstalledUpdate(manifest, versions[0], { execute: true, confirm: async () => false }))
        .rejects.toThrow('did not confirm')
      await expect(packageInstalledUpdate(manifest, versions[0], { execute: true, confirm: async () => {
        await mkdir(join(root, '.dsh-desktop-signing'))
        await writeFile(join(root, '.dsh-desktop-signing/attempt.json'), 'another operation acquired the token')
        return true
      } })).rejects.toThrow('interlock exists')
      expect(await readdir(join(manifest, '..', versions[0]))).toEqual(['dsh'])
    })
  })

  it.runIf(process.platform === 'win32' && process.arch === 'x64').each(['output', 'source', 'git-head', 'git-status'] as const)(
    'refuses an intervening %s change before launching the builder', async (change) => {
      await fixture(async (manifest, root) => {
        await expect(packageInstalledUpdate(manifest, versions[0], { execute: true, confirm: async () => {
          if (change === 'source') await writeFile(join(root, 'certificate.cer'), 'changed certificate bytes')
          else if (change === 'git-head') state.sourceCommit = 'b'.repeat(40)
          else if (change === 'git-status') state.dirtyFiles = ' M apps/desktop/package.json'
          else {
            await mkdir(join(manifest, '..', versions[0], 'installer'))
            await writeFile(join(manifest, '..', versions[0], 'installer/owner.txt'), 'preserve')
          }
          return true
        } })).rejects.toThrow(change === 'output' ? 'EEXIST' : 'recorded source or tool inputs changed before packaging')
        const parent = join(manifest, '..', versions[0], 'packaging')
        const record = join(parent, (await readdir(parent))[0]!)
        expect(await readFile(join(record, 'events.jsonl'), 'utf8')).not.toContain('stage-spawn')
        expect(JSON.parse(await readFile(join(record, 'result.json'), 'utf8'))).toMatchObject({ success: false })
        if (change === 'output') expect(await readFile(join(manifest, '..', versions[0], 'installer/owner.txt'), 'utf8')).toBe('preserve')
      })
    },
  )
})
