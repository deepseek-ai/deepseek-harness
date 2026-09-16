/** In-place owner of the desktop profile and its pnpm operations. */

import { spawn } from 'node:child_process'
import {
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { desktopNodeEnvironment } from './node-environment.ts'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import {
  initProfile, PROFILE_TEMPLATES, readProfileManifest, readProfilePlugins, reconcileProfilePlugins,
  unlinkProfileModuleFallback, writeProfileBundles, type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'
import { migrateDesktopProfileLinks } from './profile-packages.ts'
import { cleanProfileCorePackages } from './profile-core-cleanup.ts'

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  /** Installed version, or the dependency spec when installed metadata is unavailable. */
  readonly version: string
  readonly enabled: boolean
}

/** Exact executables the desktop shell bundles. */
export interface DesktopRuntimeExecutables {
  readonly node: string
  readonly nodeBin?: string
  readonly pnpm: string
  readonly dsh: string
}

/** Hooks that stop the backend before profile writes and restart it after each attempted change. */
export interface DesktopProjectHooks {
  /** Stop the active backend and await process exit before modifying its files. */
  beforeChange(): Promise<void>
  /** Start the current profile even when package preparation failed with partial writes. */
  afterChange(): Promise<void>
}

/** Supported dependency mutation. */
export type DesktopProjectMutation =
  | { readonly type: 'plugin-add'; readonly spec: string }
  | { readonly type: 'plugin-remove'; readonly name: string }
  | { readonly type: 'plugin-update'; readonly name: string; readonly version: string }
  | { readonly type: 'plugin-toggle'; readonly name: string; readonly enabled: boolean }

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
const MAX_PNPM_DIAGNOSTIC_BYTES = 64 * 1024

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Desktop npm project manager with direct writes and no rollback. */
export class DesktopProjectManager {
  private lockDescriptor: number | undefined
  private descriptor: DesktopRuntimeDescriptor | undefined

  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - absolute Electron and pnpm entry paths.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: DesktopRuntimeExecutables,
  ) {}

  /** Read the active desktop plugin inventory. */
  listPlugins(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    return readProfilePlugins(this.pluginLocation(this.paths.profile)).dependencies
      .map(({ name, version, enabled }) => ({ name, version, enabled }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Disable third-party bundles without loading application resources or deleting plugin files.
   * @returns Completion of the locked profile write; the caller must stop the Host first.
   */
  async disableAllPlugins(): Promise<void> {
    await this.withLock(() => {
      if (!existsSync(join(this.paths.profile, 'package.json'))) return
      writeProfileBundles(this.paths.profile, readProfileManifest('dsh', this.paths.profile), WEB_PROFILE.bundles)
    })
  }

  /** Read the dsh version supplied by this application's verified resources. */
  dshVersion(): string {
    return this.currentRuntime().release.version
  }

  private currentRuntime(): DesktopRuntimeDescriptor {
    if (this.descriptor === undefined) throw new Error('desktop project: runtime metadata has not been loaded')
    return this.descriptor
  }

  private readRuntime(): DesktopRuntimeDescriptor {
    this.descriptor = undefined
    return readDesktopRuntime(this.runtime.dsh)
  }

  private pluginLocation(profileDir: string) {
    return { binName: 'dsh', profileDir, installAnchor: join(this.runtime.dsh, 'node_modules', DSH_PACKAGE, 'package.json') }
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   * @param production - Remove application-owned profile packages before packaged Host startup.
   */
  async applyRelease(production = false): Promise<void> {
    await this.withLock(() => {
      this.descriptor = this.readRuntime()
      cleanProfileCorePackages(this.paths.profile, this.descriptor.sharedPackages.map(entry => entry.name), production)
      migrateProfileSettings(this.paths.profile)
      migrateDesktopProfileLinks(this.paths.profile)
      createPluginProfile(this.paths.profile)
    })
  }

  /** Modify the current profile while its backend is stopped; failures retain partial changes. */
  async mutate(mutation: DesktopProjectMutation, hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      this.currentRuntime()
      if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
      await hooks.beforeChange()
      try {
        await this.applyMutation(this.paths.profile, mutation)
      } catch (error) {
        try { await hooks.afterChange() } catch (restartError) {
          throw new AggregateError([error, restartError], 'Desktop package operation and backend restart failed')
        }
        throw error
      }
      await hooks.afterChange()
    })
  }

  private async applyMutation(projectDir: string, mutation: DesktopProjectMutation): Promise<void> {
    const location = this.pluginLocation(projectDir)
    const before = readProfilePlugins(location)
    const bundles = before.manifest.dsh?.profile?.bundles ?? []
    switch (mutation.type) {
      case 'plugin-add':
      case 'plugin-update': {
        const spec = mutation.type === 'plugin-add' ? mutation.spec : `${mutation.name}@${mutation.version}`
        unlinkProfileModuleFallback(projectDir)
        await this.runPnpm(projectDir, ['add', '--', spec])
        reconcileProfilePlugins({ ...location, before, preserveDisabled: true })
        return
      }
      case 'plugin-remove':
        unlinkProfileModuleFallback(projectDir)
        await this.runPnpm(projectDir, ['remove', '--', mutation.name])
        reconcileProfilePlugins({ ...location, before, preserveDisabled: true })
        return
      case 'plugin-toggle':
        writeProfileBundles(projectDir, before.manifest, mutation.enabled
          ? bundles.includes(mutation.name) ? bundles : [...bundles, mutation.name]
          : bundles.filter(name => name !== mutation.name))
        return
      default:
        mutation satisfies never
    }
  }

  private async runPnpm(projectDir: string, args: readonly string[]): Promise<void> {
    await new Promise<void>((settle, reject) => {
      const child = spawn(this.runtime.node, ['--expose-internals', this.runtime.pnpm, ...args], {
        cwd: projectDir,
        env: desktopNodeEnvironment(this.runtime.node, this.runtime.nodeBin, process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let failure: Error | undefined
      let diagnostics = ''
      let completed = false
      const appendDiagnostics = (chunk: string): void => {
        diagnostics = (diagnostics + chunk).slice(-MAX_PNPM_DIAGNOSTIC_BYTES)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', appendDiagnostics)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', appendDiagnostics)
      const complete = (settleChild: () => void): void => {
        if (completed) return
        completed = true
        try {
          this.writeLockOwner(process.pid)
        } catch (error) {
          reject(errorOf(error, 'desktop project: failed to return the package transaction lock to Electron'))
          return
        }
        settleChild()
      }
      child.once('error', (error) => { failure = error })
      child.once('close', (code, signal) => {
        complete(() => {
          if (failure !== undefined) { reject(failure); return }
          if (code === 0) {
            settle()
            return
          }
          reject(new Error(
            `desktop project: pnpm exited with ${String(code ?? signal)}${diagnostics.trim() === '' ? '' : `: ${diagnostics.trim()}`}`,
          ))
        })
      })
      try {
        if (child.pid === undefined) throw new Error('desktop project: pnpm did not report a process id')
        this.writeLockOwner(child.pid)
      } catch (error) {
        failure = errorOf(error, 'desktop project: failed to assign the package transaction lock to pnpm')
        child.kill('SIGKILL')
      }
    })
  }

  private writeLockOwner(pid: number): void {
    const descriptor = this.lockDescriptor
    if (descriptor === undefined) throw new Error('desktop project: package transaction lost its lock')
    const content = Buffer.from(`${String(pid)}\n`)
    ftruncateSync(descriptor, 0)
    writeSync(descriptor, content, 0, content.byteLength, 0)
    fsyncSync(descriptor)
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    let descriptor: number
    try {
      descriptor = openSync(this.paths.lock, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(this.paths.lock)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: package transaction lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(this.paths.lock, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another package transaction is active')
        unlinkSync(this.paths.lock)
        descriptor = openSync(this.paths.lock, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      this.lockDescriptor = descriptor
      this.writeLockOwner(process.pid)
      return await operation()
    } finally {
      this.lockDescriptor = undefined
      closeSync(descriptor)
      unlinkSync(this.paths.lock)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  initProfile(projectDir, WEB_PROFILE.bundles)
}
