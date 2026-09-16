/** Shared profile package operations used by dsh plugin and the running manager. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DEFAULT_PROFILE_BUNDLES, initProfile, PROFILE_TEMPLATES, readProfileManifest,
  resolveBundleDir, resolveProfileDir, loadOverlayPatches, type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { PackageResult } from './types.ts'

/** Profile and invocation locations supplied by the launcher. */
export interface PackageOperationContext {
  profile: string
  /** Explicit directory for an application-owned profile; named CLI profiles resolve under home. */
  dir?: string
  installAnchor: string
  cwd: string
  home?: string
}

/** Output and cancellation policy for one pnpm operation. */
export interface PackageOperationOptions {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. Defaults to `pnpm`. */
  command?: string
  /** CLI inherits authentication and terminal descriptors; service scrubs secrets and captures output. */
  execution: 'cli' | 'service'
  signal?: AbortSignal
  outputBytes: number
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  activateNewBundles?: boolean
  lockWaitMs?: number
}

/** Resolve relative package specs against the caller's directory.
 * @param argument One pnpm argument.
 * @param cwd Invocation directory, never the profile directory.
 * @returns Anchored argument.
 */
export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}

/** Read bundle metadata without loading its JavaScript.
 * @param name Installed dependency or installation-owned package name.
 * @param dir Profile directory.
 * @param anchor Installation manifest.
 * @returns Resolved metadata, or undefined for packages without bundle metadata.
 */
export function bundleManifest(name: string, dir: string, anchor: string): ProfileManifest | undefined {
  const packageDir = resolveBundleDir('dsh', name, anchor, dir)
  const manifest = readProfileManifest('dsh', packageDir)
  return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest
}

/** Atomically save a profile manifest while retaining unrelated fields.
 * @param dir Profile directory.
 * @param manifest Updated document.
 */
export async function saveManifest(dir: string, manifest: ProfileManifest): Promise<void> {
  await writeFileAtomic(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
}

/** Reconcile package removals and newly installed bundles without re-enabling retained dependencies. */
async function reconcile(before: ProfileManifest, dir: string, anchor: string, options: PackageOperationOptions): Promise<void> {
  const after = readProfileManifest('dsh', dir)
  const dependencies = Object.keys(after.dependencies ?? {})
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const previous = after.dsh?.profile?.bundles ?? []
  const bundles = previous.filter((name) => {
    if (!beforeDeps.has(name) && !dependencies.includes(name)) return true
    return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== undefined
  })
  for (const name of dependencies) {
    if (beforeDeps.has(name)) continue
    const metadata = bundleManifest(name, dir, anchor)
    if (metadata?.dsh?.bundle === undefined) {
      options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr')
      continue
    }
    loadOverlayPatches('dsh', join(resolveBundleDir('dsh', name, anchor, dir), metadata.dsh.bundle.patch))
    if (!bundles.includes(name)) {
      bundles.push(name)
    }
  }
  if (JSON.stringify(previous) === JSON.stringify(bundles)) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } }
  await saveManifest(dir, after)
}

/** Execute pnpm inside a profile whose caller already holds the profile write lock.
 * @param context Launcher-owned profile and resolution locations.
 * @param args Pnpm arguments, before relative path anchoring.
 * @param options Output, activation and cancellation policy.
 * @returns Exit status and diagnostic path; service output is bounded, CLI output uses inherited descriptors.
 */
export async function runProfilePnpm(
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
): Promise<PackageResult> {
  const dir = context.dir ?? resolveProfileDir(context.profile, context.home)
  const before = readProfileManifest('dsh', dir)
  const logRoot = join(dir, '.plugin-manager', 'logs')
  await mkdir(logRoot, { recursive: true, mode: 0o700 })
  const logDir = await mkdtemp(join(logRoot, 'operation-'))
  const logPath = join(logDir, 'pnpm.log')
  const log = await open(logPath, 'wx', 0o600)
  let output = Buffer.alloc(0)
  let truncated = false
  const cancellation = new AbortController()
  const child = execa(options.command ?? 'pnpm', args.map(arg => anchorPathSpec(arg, context.cwd)), {
    cwd: dir, env: options.execution === 'cli' ? process.env : scrubbedParentEnv(), extendEnv: false, reject: false,
    stdout: options.execution === 'cli' ? 'inherit' : 'pipe',
    stderr: options.execution === 'cli' ? 'inherit' : 'pipe',
    buffer: false, stdin: options.execution === 'cli' ? 'inherit' : 'ignore', cancelSignal: options.signal === undefined
      ? cancellation.signal : AbortSignal.any([cancellation.signal, options.signal]),
  })
  let writes = Promise.resolve()
  const collect = async (stream: AsyncIterable<Buffer | string>, kind: 'stdout' | 'stderr') => {
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        writes = writes.then(async () => { await log.write(bytes) })
        await writes
        options.onOutput?.(bytes.toString('utf8'), kind)
        output = Buffer.concat([output, bytes])
        if (output.length > options.outputBytes) {
          truncated = true
          output = output.subarray(output.length - options.outputBytes)
        }
      }
    } catch (error) {
      cancellation.abort()
      throw error
    }
  }
  let exitCode: number
  try {
    const [completion, ...streams] = await Promise.allSettled([child,
      ...child.stdout === null ? [] : [collect(child.stdout, 'stdout')],
      ...child.stderr === null ? [] : [collect(child.stderr, 'stderr')],
    ])
    for (const stream of streams) if (stream.status === 'rejected') throw stream.reason
    if (completion.status === 'rejected') throw completion.reason
    const result = completion.value
    exitCode = result.exitCode ?? (result.code === 'ENOENT' ? 127 : 1)
    if (result.failed && output.length === 0) {
      const diagnostic = result.shortMessage ?? 'pnpm failed'
      await log.write(diagnostic)
      truncated = Buffer.byteLength(diagnostic) > options.outputBytes
      output = Buffer.from(diagnostic).subarray(0, options.outputBytes)
    }
    if (exitCode === 0 && options.activateNewBundles !== false) await reconcile(before, dir, context.installAnchor, options)
  } finally {
    await log.close()
  }
  return { exitCode, output: output.toString('utf8'), truncated, logPath }
}

/** Initialize and run the dsh plugin command with the same write lock as the service.
 * @param context Launcher-owned locations.
 * @param args Pnpm arguments.
 * @param options Output and cancellation policy.
 * @returns Completed package-manager result.
 */
export async function runPluginCommand(
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
): Promise<PackageResult> {
  const dir = context.dir ?? resolveProfileDir(context.profile, context.home)
  await mkdir(dir, { recursive: true })
  return withFileLock(join(dir, 'package.json'), async () => {
    if (!existsSync(join(dir, 'package.json'))) {
      const template = PROFILE_TEMPLATES[context.profile]
      initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES)
      options.onOutput?.(`dsh: initialized profile ${context.profile} at ${dir}\n`, 'stderr')
    }
    return runProfilePnpm(context, args, options)
  }, options.lockWaitMs === undefined ? undefined : { waitMs: options.lockWaitMs })
}

/** What one registry lookup answered. */
export interface PackageViewResult {
  /** pnpm's exit code, null when it ended without one or never started. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** The lookup ran past its bound and was killed. */
  timedOut: boolean
  /** The failure of starting pnpm at all, when that is what happened. */
  cause?: unknown
}

/** Bounds of one registry lookup. */
export interface PackageViewOptions {
  /** The pnpm executable name or path. Defaults to `pnpm`. */
  command?: string
  /** Ends the lookup early; the caller's signal, when it has one. */
  signal?: AbortSignal
  /** Bound on the lookup, in milliseconds. */
  timeoutMs: number
}

/**
 * Ask the registry what a spec names through `pnpm view`, run in the profile
 * directory so the registry, proxy, and authentication settings of an install apply.
 * @param dir Profile directory.
 * @param spec One registry spec: a package name with an optional range.
 * @param options Cancellation and the time bound.
 * @returns pnpm's exit, output, and how the lookup ended.
 */
export async function viewProfilePackage(dir: string, spec: string, options: PackageViewOptions): Promise<PackageViewResult> {
  const result = await execa(options.command ?? 'pnpm', ['view', spec, 'name', 'version', 'description', 'dsh', '--json'], {
    cwd: dir, env: scrubbedParentEnv(), extendEnv: false, reject: false, stdin: 'ignore',
    timeout: options.timeoutMs, ...options.signal === undefined ? {} : { cancelSignal: options.signal },
  })
  const cause = result.exitCode === undefined && !result.timedOut && !result.isCanceled
    ? Object.assign(new Error(result.shortMessage), { code: result.code })
    : undefined
  return {
    exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut,
    ...cause === undefined ? {} : { cause },
  }
}
