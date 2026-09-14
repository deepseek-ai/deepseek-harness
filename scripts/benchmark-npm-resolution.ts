/** Benchmark npm's dependency-tree resolution against an all-local registry. */

import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

const TARGET_PACKAGE = '@deepseek-ai/dsh'
const DEFAULT_TIMEOUT_MS = 300_000
const TERMINATION_GRACE_MS = 1_000
const FORCED_EXIT_TIMEOUT_MS = 5_000
const WORKSPACE_MANIFEST_GLOBS = [
  'apps/*/package.json',
  'packages/*/*/package.json',
  'vendor/*/package.json',
  'native/system/package.json',
  'native/system/packages/*/package.json',
]
const INSTALLED_MANIFEST_GLOBS = [
  'node_modules/.pnpm/*/node_modules/*/package.json',
  'node_modules/.pnpm/*/node_modules/@*/*/package.json',
]
const PUBLISHED_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'engines',
  'os',
  'cpu',
  'bin',
] as const

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, unknown>
  readonly engines?: unknown
  readonly os?: unknown
  readonly cpu?: unknown
  readonly bin?: unknown
}

interface RegistryVersion extends PackageManifest {
  readonly name: string
  readonly version: string
}

/** Package versions served by the local benchmark registry. */
export type RegistryIndex = ReadonlyMap<string, ReadonlyMap<string, RegistryVersion>>

/** Parsed command-line options for one benchmark invocation. */
export interface BenchmarkOptions {
  readonly ref?: string
  readonly runs: number
  readonly timeoutMs: number
  readonly maxMs?: number
}

/** One measured npm resolution. */
export interface BenchmarkRun {
  readonly durationMs: number
  readonly registryRequests: number
  readonly archiveRequests: number
  readonly unknownPackages: readonly string[]
}

/** Published-package fields retained in npm's package-lock layout. */
export interface NpmLockPackage {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}

/** The installed paths selected by npm without materializing package archives. */
export interface NpmPackageLock {
  readonly lockfileVersion: number
  readonly packages: Readonly<Record<string, NpmLockPackage>>
}

/** npm resolution observations together with its computed install layout. */
export interface NpmPackageLockResolution extends BenchmarkRun {
  readonly packageLock: NpmPackageLock
}

/** Parse one positive-integer command-line option or use its default. */
export function parsePositiveIntegerOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== raw) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Parse supported benchmark arguments.
 * @param args - Command-line arguments after the script path.
 * @returns Validated benchmark options.
 */
export function parseBenchmarkOptions(args: readonly string[]): BenchmarkOptions {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const { values } = parseArgs({
    args: [...normalized],
    options: {
      ref: { type: 'string' },
      runs: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-ms': { type: 'string' },
    },
    allowPositionals: false,
  })
  const maxMs = values['max-ms'] === undefined
    ? undefined
    : parsePositiveIntegerOption(values['max-ms'], 0, '--max-ms')
  return {
    runs: parsePositiveIntegerOption(values.runs, 1, '--runs'),
    timeoutMs: parsePositiveIntegerOption(values['timeout-ms'], DEFAULT_TIMEOUT_MS, '--timeout-ms'),
    ...(values.ref === undefined ? {} : { ref: values.ref }),
    ...(maxMs === undefined ? {} : { maxMs }),
  }
}

function workspaceManifestPath(path: string): boolean {
  return /^(?:apps\/[^/]+|packages\/[^/]+\/[^/]+|vendor\/[^/]+|native\/system(?:\/packages\/[^/]+)?)\/package\.json$/.test(path)
}

function workspaceManifestPaths(root: string, ref: string | undefined): string[] {
  if (ref === undefined) return globSync(WORKSPACE_MANIFEST_GLOBS, { cwd: root }).sort()
  return execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'apps', 'packages', 'vendor', 'native'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\n').filter(workspaceManifestPath).sort()
}

function readGitFiles(root: string, ref: string, paths: readonly string[]): ReadonlyMap<string, string> {
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map(path => `${ref}:${path}\n`).join(''),
    maxBuffer: 64 * 1024 * 1024,
  })
  const contents = new Map<string, string>()
  let offset = 0
  for (const path of paths) {
    const headerEnd = output.indexOf(0x0a, offset)
    if (headerEnd < 0) throw new Error(`git cat-file returned no header for ${ref}:${path}`)
    const header = output.subarray(offset, headerEnd).toString('utf8')
    if (header.endsWith(' missing')) throw new Error(`git ref ${ref} has no ${path}`)
    const size = Number.parseInt(header.split(' ')[2] ?? '', 10)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git cat-file returned an invalid size for ${ref}:${path}`)
    }
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (output[contentEnd] !== 0x0a) throw new Error(`git cat-file truncated ${ref}:${path}`)
    contents.set(path, output.subarray(contentStart, contentEnd).toString('utf8'))
    offset = contentEnd + 1
  }
  return contents
}

/**
 * Convert a workspace protocol range to the range published by pnpm pack.
 * @param range - Dependency range from a workspace manifest.
 * @param targetVersion - Current version of the referenced workspace package.
 * @returns The registry-facing semver range.
 */
export function publishWorkspaceRange(range: string, targetVersion: string): string {
  if (range === 'workspace:*') return targetVersion
  if (range === 'workspace:^') return `^${targetVersion}`
  if (range === 'workspace:~') return `~${targetVersion}`
  if (range.startsWith('workspace:')) return range.slice('workspace:'.length)
  return range
}

function copyPublishedManifest(
  source: PackageManifest,
  workspaceVersions: ReadonlyMap<string, string>,
): RegistryVersion | undefined {
  if (typeof source.name !== 'string' || typeof source.version !== 'string') return undefined
  const output: Record<string, unknown> = { name: source.name, version: source.version }
  for (const field of PUBLISHED_FIELDS) {
    const value = source[field]
    if (value === undefined) continue
    if (field === 'dependencies' || field === 'optionalDependencies' || field === 'peerDependencies') {
      output[field] = Object.fromEntries(Object.entries(value as Record<string, string>).map(([name, range]) => {
        const targetVersion = workspaceVersions.get(name)
        return [name, targetVersion === undefined ? range : publishWorkspaceRange(range, targetVersion)]
      }))
    } else {
      output[field] = structuredClone(value)
    }
  }
  return output as unknown as RegistryVersion
}

function addManifest(index: Map<string, Map<string, RegistryVersion>>, manifest: RegistryVersion): void {
  const versions = index.get(manifest.name) ?? new Map<string, RegistryVersion>()
  versions.set(manifest.version, manifest)
  index.set(manifest.name, versions)
}

/**
 * Build registry metadata from installed external packages and workspace manifests.
 * @param root - Repository root containing the pnpm virtual store.
 * @param ref - Optional Git ref used instead of working-tree workspace manifests.
 * @returns Package metadata served by the benchmark registry.
 */
export function buildRegistryIndex(root: string, ref?: string): RegistryIndex {
  const index = new Map<string, Map<string, RegistryVersion>>()
  for (const path of globSync(INSTALLED_MANIFEST_GLOBS, { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifest
    const copied = copyPublishedManifest(manifest, new Map())
    if (copied !== undefined) addManifest(index, copied)
  }

  const paths = workspaceManifestPaths(root, ref)
  const refContents = ref === undefined ? undefined : readGitFiles(root, ref, paths)
  const workspace = paths.map(path =>
    JSON.parse(refContents?.get(path) ?? readFileSync(resolve(root, path), 'utf8')) as PackageManifest)
  const workspaceVersions = new Map(workspace.flatMap(manifest =>
    typeof manifest.name === 'string' && typeof manifest.version === 'string'
      ? [[manifest.name, manifest.version] as const]
      : []))
  for (const manifest of workspace) {
    const copied = copyPublishedManifest(manifest, workspaceVersions)
    if (copied !== undefined) addManifest(index, copied)
  }
  return index
}

function latestVersion(versions: ReadonlyMap<string, RegistryVersion>): string {
  const sorted = [...versions.keys()].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  const latest = sorted.at(-1)
  if (latest === undefined) throw new Error('local registry package has no versions')
  return latest
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('local registry did not expose a TCP port'))
        return
      }
      resolveListen(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else reject(error)
    })
  })
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function signalProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) {
    child.kill(signal)
    return
  }
  if (process.platform === 'win32') {
    const force = signal === 'SIGKILL' ? ['/F'] : []
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', ...force], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0 && child.exitCode === null && child.signalCode === null) child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * Run one command with bounded process-tree termination after its deadline.
 * @param command - Executable path or name.
 * @param args - Arguments passed without shell interpolation on POSIX.
 * @param options - Working directory, environment, timeout, and termination grace.
 * @returns Exit facts, captured output, duration, and whether timeout handling began.
 */
export async function runCommandWithTimeout(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly timeoutMs: number
    readonly terminationGraceMs?: number
  },
): Promise<{ status: number | null; signal: NodeJS.Signals | null; durationMs: number; output: string; timedOut: boolean }> {
  const started = performance.now()
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: options.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (status, signal) => { resolveExit({ status, signal }) })
  })
  let timeout: NodeJS.Timeout | undefined
  try {
    const first = await Promise.race([
      exited.then(outcome => ({ type: 'exit' as const, outcome })),
      new Promise<{ type: 'timeout' }>((resolveTimeout) => {
        timeout = setTimeout(() => { resolveTimeout({ type: 'timeout' }) }, options.timeoutMs)
      }),
    ])
    if (first.type === 'exit') {
      return { ...first.outcome, durationMs: performance.now() - started, output, timedOut: false }
    }

    signalProcessTree(child, 'SIGTERM')
    await delay(options.terminationGraceMs ?? TERMINATION_GRACE_MS)
    signalProcessTree(child, 'SIGKILL')
    const forced = await Promise.race([
      exited,
      delay(FORCED_EXIT_TIMEOUT_MS).then(() => undefined),
    ])
    if (forced === undefined) throw new Error('timed-out process tree did not exit after SIGKILL')
    return { ...forced, durationMs: performance.now() - started, output, timedOut: true }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function readNpmPackageLock(path: string): NpmPackageLock {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm produced an invalid package-lock.json')
  }
  const { lockfileVersion, packages } = parsed as Record<string, unknown>
  if (!Number.isSafeInteger(lockfileVersion) || packages === null
    || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('npm produced an invalid package-lock.json')
  }
  return parsed as NpmPackageLock
}

async function runNpm(
  cwd: string,
  registry: string,
  timeoutMs: number,
): Promise<{ durationMs: number; output: string; timedOut: boolean }> {
  const npmrc = join(cwd, '.npmrc')
  const globalNpmrc = join(cwd, '.npmrc-global')
  writeFileSync(npmrc, `registry=${registry}\n@deepseek-ai:registry=${registry}\n`)
  writeFileSync(globalNpmrc, '')
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.toLowerCase().startsWith('npm_config_')))
  const result = await runCommandWithTimeout(npmExecutable(), [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--include=peer',
    '--install-strategy=hoisted',
    '--legacy-peer-deps=false',
    `--registry=${registry}`,
  ], {
    cwd,
    env: {
      ...inheritedEnvironment,
      npm_config_cache: join(cwd, '.npm-cache'),
      npm_config_globalconfig: globalNpmrc,
      npm_config_userconfig: npmrc,
      npm_config_update_notifier: 'false',
    },
    timeoutMs,
  })
  if (result.timedOut) return result
  if (result.status !== 0) {
    throw new Error(`npm install exited ${String(result.status)} after ${result.durationMs.toFixed(0)} ms\n${result.output.trim()}`)
  }
  return result
}

/**
 * Ask npm to compute an install layout without downloading package archives.
 * @param index - Package metadata exposed through the local registry.
 * @param dependencies - Root dependencies whose install layout npm computes.
 * @param timeoutMs - Hard wall-clock limit for the npm child process.
 * @returns The package lock plus timing and registry-request observations.
 */
export async function resolveNpmPackageLock(
  index: RegistryIndex,
  dependencies: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<NpmPackageLockResolution> {
  let registryRequests = 0
  let archiveRequests = 0
  const unknownPackages = new Set<string>()
  let registry = ''
  const server = createServer((request, response) => {
    registryRequests++
    const pathname = new URL(request.url ?? '/', registry).pathname
    if (pathname.startsWith('/tarballs/')) {
      archiveRequests++
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'package-lock-only benchmark requested an archive' }))
      return
    }
    const name = decodeURIComponent(pathname.slice(1))
    const versions = index.get(name)
    if (versions === undefined) {
      unknownPackages.add(name)
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))
      return
    }
    const materialized = Object.fromEntries([...versions].map(([version, manifest]) => [version, {
      ...manifest,
      dist: { tarball: `${registry}tarballs/${encodeURIComponent(name)}-${version}.tgz` },
    }]))
    const body = JSON.stringify({
      name,
      'dist-tags': { latest: latestVersion(versions) },
      versions: materialized,
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  })
  const port = await listen(server)
  registry = `http://127.0.0.1:${String(port)}/`
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-npm-resolution-'))
  try {
    writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
      name: 'dsh-npm-resolution-benchmark',
      version: '0.0.0',
      private: true,
      dependencies,
    }, null, 2)}\n`)
    const result = await runNpm(consumer, registry, timeoutMs)
    if (result.timedOut) throw new Error(`npm resolution exceeded ${String(timeoutMs)} ms`)
    return {
      durationMs: result.durationMs,
      registryRequests,
      archiveRequests,
      unknownPackages: [...unknownPackages].sort(),
      packageLock: readNpmPackageLock(join(consumer, 'package-lock.json')),
    }
  } finally {
    server.closeAllConnections()
    await close(server)
    rmSync(consumer, { recursive: true, force: true })
  }
}

/**
 * Resolve the CLI install graph once without downloading package archives.
 * @param index - Package metadata exposed through the local registry.
 * @param targetVersion - Version of `@deepseek-ai/dsh` to install.
 * @param timeoutMs - Hard wall-clock limit for the npm child process.
 * @returns Timing and registry-request observations.
 */
export async function benchmarkNpmResolution(
  index: RegistryIndex,
  targetVersion: string,
  timeoutMs: number,
): Promise<BenchmarkRun> {
  const result = await resolveNpmPackageLock(index, { [TARGET_PACKAGE]: targetVersion }, timeoutMs)
  return {
    durationMs: result.durationMs,
    registryRequests: result.registryRequests,
    archiveRequests: result.archiveRequests,
    unknownPackages: result.unknownPackages,
  }
}

async function main(): Promise<void> {
  const options = parseBenchmarkOptions(process.argv.slice(2))
  const root = resolve(import.meta.dirname, '..')
  const started = performance.now()
  const index = buildRegistryIndex(root, options.ref)
  const targetVersions = index.get(TARGET_PACKAGE)
  if (targetVersions === undefined) throw new Error(`local registry contains no ${TARGET_PACKAGE}`)
  const targetVersion = latestVersion(targetVersions)
  const npmVersion = execFileSync(npmExecutable(), ['--version'], { encoding: 'utf8' }).trim()
  console.log(
    `benchmark-npm-resolution: npm ${npmVersion}, ${options.ref === undefined ? 'working tree' : options.ref}, `
    + `${String(index.size)} package name(s), setup ${(performance.now() - started).toFixed(0)} ms.`,
  )
  const durations: number[] = []
  for (let run = 1; run <= options.runs; run++) {
    const result = await benchmarkNpmResolution(index, targetVersion, options.timeoutMs)
    durations.push(result.durationMs)
    console.log(
      `benchmark-npm-resolution: run ${String(run)}/${String(options.runs)} resolved ${TARGET_PACKAGE}@${targetVersion}`
      + ` in ${(result.durationMs / 1000).toFixed(2)} s with ${String(result.registryRequests)} metadata request(s)`
      + ` and ${String(result.unknownPackages.length)} local 404 package name(s).`,
    )
    if (result.archiveRequests > 0) throw new Error('npm requested package archives during the metadata-only benchmark')
  }
  const minimum = Math.min(...durations)
  const maximum = Math.max(...durations)
  console.log(
    `benchmark-npm-resolution: ${String(options.runs)} run(s), min ${(minimum / 1000).toFixed(2)} s, max ${(maximum / 1000).toFixed(2)} s.`,
  )
  if (options.maxMs !== undefined && maximum > options.maxMs) {
    throw new Error(`npm resolution exceeded --max-ms=${String(options.maxMs)} (max ${maximum.toFixed(0)} ms)`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`benchmark-npm-resolution: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
