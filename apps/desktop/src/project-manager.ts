/** In-place owner of the reserved desktop profile and its private pnpm state. */

import { valid } from 'semver'
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
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import { removeOwnedDirectory } from './owned-directory.ts'
import type { DesktopRelease } from './release.ts'
import { desktopRuntimeId, readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import {
  desktopPluginLockHash, linkDesktopHostPackages, readDesktopProfileState,
  unlinkDesktopHostPackages, validateDesktopPluginGraph, type DesktopProfileState,
} from './profile-packages.ts'

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** Installed desktop project manifest slice. */
interface DesktopProjectManifest {
  readonly name: string
  readonly private: true
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly dsh: {
    readonly profile: {
      readonly bundles: string[]
    }
  }
}

/** Exact executables the desktop shell bundles. */
export interface DesktopRuntimeExecutables {
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

/** Hooks that stop the backend before profile writes and restart it after success. */
export interface DesktopProjectHooks {
  /** Stop the active backend and await process exit before modifying its files. */
  beforeChange(): Promise<void>
  /** Start the modified profile after package preparation succeeds. */
  afterChange(): Promise<void>
}

/** Supported dependency mutation. */
export type DesktopProjectMutation =
  | { readonly type: 'plugin-add'; readonly spec: string }
  | { readonly type: 'plugin-remove'; readonly name: string }
  | { readonly type: 'plugin-update'; readonly name: string; readonly version: string }
  | { readonly type: 'plugin-toggle'; readonly name: string; readonly enabled: boolean }
  | { readonly type: 'plugins-disable-all' }

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const MAX_PNPM_DIAGNOSTIC_BYTES = 64 * 1024
const DESKTOP_REGISTRY = 'https://registry.npmjs.org/'

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`desktop project: invalid npm package name ${JSON.stringify(name)}`)
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`desktop project: invalid exact version ${JSON.stringify(version)}`)
}

/**
 * Validate one registry package spec and return its package name.
 * @param spec - npm registry name with an optional version or tag.
 * @returns Requested package name.
 */
export function packageNameFromSpec(spec: string): string {
  if (spec === '' || spec.startsWith('-') || /[\s\\]/u.test(spec) || spec.includes('://') || spec.startsWith('file:')) {
    throw new Error(`desktop project: unsupported npm package spec ${JSON.stringify(spec)}`)
  }
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash === -1) throw new Error(`desktop project: invalid scoped package spec ${JSON.stringify(spec)}`)
    const versionAt = spec.indexOf('@', slash)
    const name = versionAt === -1 ? spec : spec.slice(0, versionAt)
    assertPackageName(name)
    if (versionAt !== -1) assertVersion(spec.slice(versionAt + 1))
    return name
  }
  const versionAt = spec.indexOf('@')
  const name = versionAt === -1 ? spec : spec.slice(0, versionAt)
  assertPackageName(name)
  if (versionAt !== -1) assertVersion(spec.slice(versionAt + 1))
  return name
}

function projectManifest(projectDir: string): DesktopProjectManifest {
  const path = join(projectDir, 'package.json')
  const value = readJson(path)
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  if (!isRecord(value) || value.name !== PROJECT_NAME || value.private !== true
    || typeof value.version !== 'string' || (value.dependencies !== undefined && !isRecord(value.dependencies))
    || !Array.isArray(profile?.bundles) || !profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error(`desktop project: invalid desktop profile manifest ${path}`)
  }
  const manifest = { ...value, dependencies: value.dependencies ?? {} } as unknown as DesktopProjectManifest
  if (Object.entries(manifest.dependencies).some(([name, version]) => !PACKAGE_NAME_PATTERN.test(name)
    || typeof version !== 'string' || valid(version) !== version)) {
    throw new Error('desktop project: plugin dependencies must use exact registry versions')
  }
  return manifest
}

function profilePluginNames(projectDir: string): readonly string[] {
  const bundles = projectManifest(projectDir).dsh.profile.bundles
  if (!DESKTOP_PROFILE_BUNDLES.every((bundle, index) => bundles[index] === bundle)) {
    throw new Error('desktop project: profile must begin with the built-in desktop bundle list')
  }
  const plugins = bundles.slice(DESKTOP_PROFILE_BUNDLES.length)
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  for (const plugin of plugins) assertPackageName(plugin)
  return plugins
}

function pluginRecords(projectDir: string): readonly DesktopPluginRecord[] {
  return Object.keys(projectManifest(projectDir).dependencies).sort().map(name => inspectPlugin(projectDir, name))
}

function writeProfilePlugins(projectDir: string, plugins: readonly DesktopPluginRecord[]): void {
  const manifest = projectManifest(projectDir)
  writeJson(join(projectDir, 'package.json'), {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: [...DESKTOP_PROFILE_BUNDLES, ...plugins.filter(plugin => plugin.enabled).map(plugin => plugin.name)],
      },
    },
  } satisfies DesktopProjectManifest)
}

function inspectPlugin(projectDir: string, requestedName: string): DesktopPluginRecord {
  const manifestPath = join(projectDir, 'node_modules', ...requestedName.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has no manifest`)
  }
  const manifest = readJson(manifestPath)
  if (!isRecord(manifest) || manifest.name !== requestedName || typeof manifest.version !== 'string') {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has inconsistent name or version`)
  }
  const dsh = manifest.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  const patch = isRecord(bundle) ? bundle.patch : undefined
  if (typeof patch !== 'string' || patch === '') {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} does not declare dsh.bundle.patch`)
  }
  const packageDir = dirname(manifestPath)
  const patchPath = resolve(packageDir, patch)
  if ((patchPath !== packageDir && !patchPath.startsWith(packageDir + sep)) || !existsSync(patchPath)) {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} declares an invalid bundle patch`)
  }
  return { name: requestedName, version: manifest.version, enabled: profilePluginNames(projectDir).includes(requestedName) }
}

/** Desktop npm project manager with direct writes and no rollback. */
export class DesktopProjectManager {
  private lockDescriptor: number | undefined
  private descriptor: DesktopRuntimeDescriptor | undefined

  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - absolute bundled Node.js and pnpm entry paths.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: DesktopRuntimeExecutables,
  ) {}

  /** Read the active desktop plugin inventory. */
  listPlugins(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    return pluginRecords(this.paths.profile)
  }

  /**
   * Reinitialize the profile, deleting configuration and third-party packages without a backup.
   * @param hooks - Stop the Host before resetting files; restart after preparation succeeds.
   * @returns Completion of reset; the held lock and shared product data are preserved.
   */
  async resetConfiguration(hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      await hooks.beforeChange()
      this.descriptor = this.readRuntime()
      for (const entry of readdirSync(this.paths.profile, { withFileTypes: true })) {
        const path = join(this.paths.profile, entry.name)
        if (path === this.paths.lock) continue
        if (entry.isDirectory()) removeOwnedDirectory(path)
        else unlinkSync(path)
      }
      createPluginProfile(this.paths.profile)
      this.prepareProfile(this.paths.profile)
      await hooks.afterChange()
    })
  }

  /** Read the dsh version supplied by this application's verified resources. */
  dshVersion(): string {
    return this.currentRuntime().release.version
  }

  /** Read the release most recently applied to the active profile. */
  releaseVersion(): string {
    const state = readDesktopProfileState(this.paths.profile)
    if (state === undefined) throw new Error('desktop project: active profile has no runtime state')
    return state.version
  }

  /** Reject a profile whose dependency links were prepared for another runtime. */
  assertProfileRuntime(projectDir: string): void {
    if (existsSync(this.pendingPackages)) throw new Error('desktop project: package preparation is incomplete; retry startup')
    if (readDesktopProfileState(projectDir)?.runtimeId !== desktopRuntimeId(this.currentRuntime())) {
      throw new Error('desktop project: profile does not match this application runtime')
    }
  }

  /** @returns Whether application resources support profile recovery. */
  canRecoverProfile(): boolean {
    return this.descriptor !== undefined && existsSync(this.runtime.node) && existsSync(this.runtime.dsh)
  }

  private get pendingPackages(): string { return join(this.paths.profile, 'desktop-packages-pending') }

  private currentRuntime(): DesktopRuntimeDescriptor {
    if (this.descriptor === undefined) throw new Error('desktop project: runtime metadata has not been loaded')
    return this.descriptor
  }

  private readRuntime(): DesktopRuntimeDescriptor {
    this.descriptor = undefined
    return readDesktopRuntime(this.runtime.dsh)
  }

  private prepareProfile(projectDir: string): void {
    const runtime = this.currentRuntime()
    linkDesktopHostPackages(projectDir, this.runtime.dsh, runtime)
    validateDesktopPluginGraph(projectDir, this.runtime.dsh, runtime, profilePluginNames(projectDir))
  }

  /** Read release metadata and reconcile its external profile without installing core packages. */
  async applyRelease(): Promise<boolean> {
    return this.withLock(async () => {
      const target = this.readRuntime()
      this.descriptor = target
      const previous = readDesktopProfileState(this.paths.profile)
      if (!existsSync(this.pendingPackages) && previous?.runtimeId === desktopRuntimeId(target)
        && previous.lockHash === desktopPluginLockHash(this.paths.profile)
        && previous.links.length === target.sharedPackages.length
        && previous.links.every(link => existsSync(link.target)
          && existsSync(join(this.paths.profile, 'node_modules', link.name))
          && realpathSync.native(link.target) === realpathSync.native(join(this.runtime.dsh, 'node_modules', link.name)))) {
        return false
      }
      if (previous === undefined) createPluginProfile(this.paths.profile)
      await this.reconcileProfile(this.paths.profile, previous)
      return true
    })
  }

  /** Modify the current profile while its backend is stopped; failures retain partial changes. */
  async mutate(mutation: DesktopProjectMutation, hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      this.currentRuntime()
      if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
      await hooks.beforeChange()
      if (mutation.type === 'plugins-disable-all') {
        const manifest = projectManifest(this.paths.profile)
        writeJson(join(this.paths.profile, 'package.json'), {
          ...manifest,
          dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [...DESKTOP_PROFILE_BUNDLES] } },
        })
        this.prepareProfile(this.paths.profile)
        await hooks.afterChange()
        return
      }
      const previous = readDesktopProfileState(this.paths.profile)
      const packagesChanged = mutation.type !== 'plugin-toggle'
      if (packagesChanged) unlinkDesktopHostPackages(this.paths.profile)
      try {
        await this.applyMutation(this.paths.profile, mutation)
      } finally {
        if (packagesChanged) linkDesktopHostPackages(this.paths.profile, this.runtime.dsh, this.currentRuntime())
      }
      await this.reconcileProfile(this.paths.profile, previous, packagesChanged)
      await hooks.afterChange()
    })
  }

  private async reconcileProfile(projectDir: string, previous: DesktopProfileState | undefined, packagesChanged = false): Promise<void> {
    const target = this.currentRuntime()
    const rebuild = (!packagesChanged && existsSync(this.pendingPackages))
      || (previous !== undefined && pluginRecords(projectDir).length > 0
      && (previous.nodeVersion !== target.release.nodeVersion || previous.platform !== target.platform || previous.arch !== target.arch))
    if (rebuild) {
      writeFileSync(this.pendingPackages, '')
      unlinkDesktopHostPackages(projectDir)
      removeOwnedDirectory(join(projectDir, 'node_modules'))
      await this.runPnpm(projectDir, ['install', '--frozen-lockfile', '--ignore-scripts'])
    }
    if (rebuild || packagesChanged) await this.finishPackageOperation(projectDir)
    else this.prepareProfile(projectDir)
  }

  private async finishPackageOperation(projectDir: string): Promise<void> {
    this.prepareProfile(projectDir)
    await this.runPnpm(projectDir, ['rebuild', '--pending'])
    this.prepareProfile(projectDir)
    unlinkSync(this.pendingPackages)
  }

  private async applyMutation(projectDir: string, mutation: Exclude<DesktopProjectMutation, { type: 'plugins-disable-all' }>): Promise<void> {
    switch (mutation.type) {
      case 'plugin-add': {
        const requestedName = packageNameFromSpec(mutation.spec)
        if (this.currentRuntime().sharedPackages.some(entry => entry.name === requestedName)) {
          throw new Error(`desktop project: cannot install host-owned package ${requestedName}`)
        }
        await this.runPnpm(projectDir, ['add', mutation.spec, '--save-exact', '--ignore-scripts'])
        const installed = { ...inspectPlugin(projectDir, requestedName), enabled: true }
        const current = pluginRecords(projectDir).filter(plugin => plugin.name !== installed.name)
        writeProfilePlugins(
          projectDir,
          [...current, installed].sort((left, right) => left.name.localeCompare(right.name)),
        )
        return
      }
      case 'plugin-remove': {
        assertPackageName(mutation.name)
        if (!Object.hasOwn(projectManifest(projectDir).dependencies, mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        const remaining = pluginRecords(projectDir).filter(plugin => plugin.name !== mutation.name)
        await this.runPnpm(projectDir, ['remove', mutation.name, '--config.ignore-scripts=true'])
        writeProfilePlugins(projectDir, remaining)
        return
      }
      case 'plugin-update':
        assertPackageName(mutation.name)
        assertVersion(mutation.version)
        if (!Object.hasOwn(projectManifest(projectDir).dependencies, mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        await this.runPnpm(projectDir, ['add', `${mutation.name}@${mutation.version}`, '--save-exact', '--ignore-scripts'])
        {
          const installed = inspectPlugin(projectDir, mutation.name)
          writeProfilePlugins(
            projectDir,
            pluginRecords(projectDir).map(plugin => plugin.name === installed.name ? installed : plugin),
          )
        }
        return
      case 'plugin-toggle': {
        assertPackageName(mutation.name)
        const plugins = pluginRecords(projectDir)
        if (!plugins.some(plugin => plugin.name === mutation.name)) throw new Error(`desktop project: plugin ${mutation.name} is not installed`)
        writeProfilePlugins(projectDir, plugins.map(plugin => (
          plugin.name === mutation.name ? { ...plugin, enabled: mutation.enabled } : plugin
        )))
        return
      }
      default:
        mutation satisfies never
    }
  }

  private async runPnpm(projectDir: string, args: readonly string[]): Promise<void> {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop project: pnpm command is required')
    for (const path of [this.paths.root, this.paths.pnpm.store, this.paths.pnpm.cache,
      this.paths.pnpm.state, this.paths.pnpm.config, this.paths.pnpm.home]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    const npmrc = join(this.paths.pnpm.config, 'npmrc')
    if (!existsSync(npmrc)) writeFileSync(npmrc, '', { mode: 0o600 })
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
      name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
    )))
    writeFileSync(this.pendingPackages, '')
    await new Promise<void>((settle, reject) => {
      const child = spawn(this.runtime.node, [
        this.runtime.pnpm,
        `--config.registry=${DESKTOP_REGISTRY}`,
        `--config.store-dir=${this.paths.pnpm.store}`,
        '--config.enable-global-virtual-store=false',
        `--config.userconfig=${npmrc}`,
        command,
        ...commandArgs,
      ], {
        cwd: projectDir,
        env: {
          ...inherited,
          COREPACK_HOME: this.paths.pnpm.home,
          NPM_CONFIG_REGISTRY: DESKTOP_REGISTRY,
          NPM_CONFIG_STORE_DIR: this.paths.pnpm.store,
          NPM_CONFIG_USERCONFIG: npmrc,
          PATH: `${dirname(this.runtime.node)}${delimiter}${process.env.PATH ?? ''}`,
          PNPM_HOME: this.paths.pnpm.home,
          XDG_CACHE_HOME: this.paths.pnpm.cache,
          XDG_CONFIG_HOME: this.paths.pnpm.config,
          XDG_STATE_HOME: this.paths.pnpm.state,
        },
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

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    if (lstatSync(this.paths.profile).isSymbolicLink()) throw new Error('desktop project: profile directory must not be a link')
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
  const manifest: DesktopProjectManifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
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
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  writeJson(join(projectDir, 'package.json'), {
    name: PROJECT_NAME, private: true, version: '0.0.0', dependencies: {},
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  } satisfies DesktopProjectManifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}
