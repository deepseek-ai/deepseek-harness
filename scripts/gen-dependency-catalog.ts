/** Generate the README npx dependency catalog from a recorded public npm resolution. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runCommandWithTimeout } from './benchmark-npm-resolution.ts'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGE = '@deepseek-ai/dsh'
const ENTRY = `node_modules/${PACKAGE}`
const REGISTRY = 'https://registry.npmjs.org/'
const LOCK = 'scripts/dependency-catalog/package-lock.json'
const METADATA = 'scripts/dependency-catalog/resolution.json'
const OUT = 'docs/dependency-catalog.json'

/** npm lockfile fields used to describe an installed package or optional candidate. */
interface PackageEntry {
  name?: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dev?: boolean
  optional?: boolean
  peer?: boolean
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

/** One package location in npm's resolved tree; duplicate versions retain their locations. */
export interface DependencyRow {
  readonly location: string
  readonly name: string
  readonly version: string
  readonly direct: boolean
  readonly optional: boolean
  readonly peer: boolean
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
}

interface ResolutionMetadata {
  capturedAt: string
  npm: string
  node: string
  platform: string
  arch: string
  registry: string
  installStrategy: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dependency-catalog: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`dependency-catalog: ${label} must be a nonempty single-line value`)
  }
  return value
}

function parseEntry(value: unknown, location: string): PackageEntry {
  const raw = record(value, location)
  const entry: PackageEntry = { version: string(raw['version'], `${location} version`) }
  if (raw['name'] !== undefined) entry.name = string(raw['name'], `${location} name`)
  if (raw['link'] === true) throw new Error(`dependency-catalog: ${location} is a local link`)
  const source = new URL(string(raw['resolved'], `${location} resolved`))
  if (source.origin !== new URL(REGISTRY).origin || source.username !== '' || source.password !== '') {
    throw new Error(`dependency-catalog: ${location} is not resolved from the public npm registry`)
  }
  for (const key of ['dev', 'optional', 'peer'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw new Error(`dependency-catalog: ${location} ${key} must be boolean`)
    entry[key] = raw[key]
  }
  for (const key of ['dependencies', 'optionalDependencies'] as const) {
    if (raw[key] === undefined) continue
    entry[key] = Object.fromEntries(Object.entries(record(raw[key], `${location} ${key}`))
      .map(([name, spec]) => [string(name, 'dependency name'), string(spec, `${location} ${name}`)]))
  }
  for (const key of ['os', 'cpu', 'libc'] as const) {
    const values = raw[key]
    if (values === undefined) continue
    if (!Array.isArray(values)) throw new Error(`dependency-catalog: ${location} ${key} must be an array`)
    entry[key] = values.map(value => string(value, `${location} ${key}`))
  }
  return entry
}

/**
 * Read npm's resolved production tree without substituting workspace or development dependencies.
 * @param input - Parsed npm lockfile v3 from a consumer with only dsh as its dependency.
 * @returns The CLI version and sorted package locations, excluding the synthetic consumer and CLI itself.
 */
export function collectDependencies(input: unknown): { version: string; rows: DependencyRow[] } {
  const lock = record(input, 'lockfile')
  if (lock['lockfileVersion'] !== 3) throw new Error('dependency-catalog: expected npm lockfileVersion 3')
  const packages = record(lock['packages'], 'packages')
  const consumer = record(packages[''], 'consumer')
  const requested = record(consumer['dependencies'], 'consumer dependencies')
  if (Object.keys(requested).length !== 1 || requested[PACKAGE] !== 'latest') {
    throw new Error(`dependency-catalog: consumer must request only ${PACKAGE}@latest`)
  }
  const entries = new Map(Object.entries(packages).filter(([location]) => location !== '')
    .map(([location, entry]) => [location, parseEntry(entry, location)]))
  const cli = entries.get(ENTRY)
  if (cli === undefined || cli.dev) throw new Error(`dependency-catalog: missing production ${PACKAGE}`)
  const direct = new Set<string>()
  for (const name of Object.keys({ ...cli.dependencies, ...cli.optionalDependencies })) {
    const location = [`${ENTRY}/node_modules/${name}`, `node_modules/${name}`]
      .find(candidate => entries.has(candidate))
    if (location === undefined) {
      if (cli.optionalDependencies?.[name] !== undefined) continue
      throw new Error(`dependency-catalog: missing direct dependency ${name}`)
    }
    direct.add(location)
  }
  const rows: DependencyRow[] = []
  for (const [location, entry] of entries) {
    if (location === ENTRY || entry.dev) continue
    const name = location.split('node_modules/').at(-1)
    if (name === undefined || !/^(@[^/]+\/)?[^/]+$/.test(name)) {
      throw new Error(`dependency-catalog: invalid npm package location ${location}`)
    }
    rows.push({
      location,
      name: entry.name ?? name,
      version: entry.version,
      direct: direct.has(location),
      optional: entry.optional === true,
      peer: entry.peer === true,
      ...(entry.os === undefined ? {} : { os: entry.os }),
      ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
      ...(entry.libc === undefined ? {} : { libc: entry.libc }),
    })
  }
  if (rows.length === 0) throw new Error('dependency-catalog: empty dependency tree')
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en')
    || a.version.localeCompare(b.version, 'en') || a.location.localeCompare(b.location, 'en'))
  return { version: cli.version, rows }
}

function readMetadata(scanRoot: string): ResolutionMetadata {
  const value = record(JSON.parse(readFileSync(resolve(scanRoot, METADATA), 'utf8')), 'resolution metadata')
  if (value['registry'] !== REGISTRY || value['installStrategy'] !== 'hoisted') {
    throw new Error('dependency-catalog: expected the public npm registry and hoisted install strategy')
  }
  return {
    capturedAt: string(value['capturedAt'], 'capturedAt'),
    npm: string(value['npm'], 'npm'),
    node: string(value['node'], 'node'),
    platform: string(value['platform'], 'platform'),
    arch: string(value['arch'], 'arch'),
    registry: value['registry'],
    installStrategy: value['installStrategy'],
  }
}

/**
 * Combine identical package versions while retaining each installation's npm flags and platform constraints.
 * @param rows - Resolved package locations, excluding the consumer and CLI.
 * @returns One sorted record per package name and version, with sorted installation locations.
 */
export function deduplicateDependencies(rows: readonly DependencyRow[]): {
  name: string
  version: string
  installations: Omit<DependencyRow, 'name' | 'version'>[]
}[] {
  const packages = new Map<string, {
    name: string
    version: string
    installations: Omit<DependencyRow, 'name' | 'version'>[]
  }>()
  for (const { name, version, ...installation } of rows) {
    const key = JSON.stringify([name, version])
    const dependency = packages.get(key) ?? { name, version, installations: [] }
    dependency.installations.push(installation)
    packages.set(key, dependency)
  }
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')
    || a.version.localeCompare(b.version, 'en'))
  for (const dependency of sorted) {
    dependency.installations.sort((a, b) => a.location.localeCompare(b.location, 'en'))
  }
  return sorted
}

function renderCatalog(lock: unknown, metadata: ResolutionMetadata): string {
  const { version, rows } = collectDependencies(lock)
  return `${JSON.stringify({
    package: PACKAGE,
    version,
    requested: `${PACKAGE}@latest`,
    resolution: metadata,
    dependencies: deduplicateDependencies(rows),
  }, null, 2)}\n`
}

/**
 * Compute the JSON catalog without network access or writes.
 * @param scanRoot - Repository root containing the recorded npm resolution.
 * @returns Deterministic JSON with one trailing newline.
 */
export function computeDependencyCatalog(scanRoot: string = ROOT): string {
  return renderCatalog(JSON.parse(readFileSync(resolve(scanRoot, LOCK), 'utf8')), readMetadata(scanRoot))
}

/**
 * Check the generated JSON against the recorded npm resolution.
 * @param scanRoot - Repository root containing the resolution and catalog.
 * @returns Whether the catalog exists and matches its inputs byte for byte.
 */
export function isDependencyCatalogCurrent(scanRoot: string = ROOT): boolean {
  return existsSync(resolve(scanRoot, OUT))
    && readFileSync(resolve(scanRoot, OUT), 'utf8') === computeDependencyCatalog(scanRoot)
}

/**
 * Isolate npm configuration and cache from the maintainer and invoking package manager.
 * @param temporary - Private consumer directory owned by the caller.
 * @param inherited - Environment whose non-npm settings remain available to the child.
 * @returns Complete child environment, including isolated user/global configuration and cache paths.
 */
export function createNpmResolutionEnvironment(
  temporary: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const userConfig = join(temporary, '.npmrc-user')
  const globalConfig = join(temporary, '.npmrc-global')
  writeFileSync(userConfig, '')
  writeFileSync(globalConfig, '')
  writeFileSync(join(temporary, '.npmrc'), `registry=${REGISTRY}\n@deepseek-ai:registry=${REGISTRY}\ninstall-strategy=hoisted\n`)
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.toLowerCase().startsWith('npm_config_'))),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: join(temporary, '.npm-cache'),
    npm_config_update_notifier: 'false',
  }
}

async function runNpm(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommandWithTimeout(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, env, timeoutMs: 300_000,
  })
  if (result.timedOut || result.status !== 0) {
    throw new Error(`dependency-catalog: npm failed (timedOut=${result.timedOut}, status=${String(result.status)}): ${result.output}`)
  }
  return result.output.trim()
}

async function refreshResolution(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-dependency-catalog-'))
  try {
    writeFileSync(join(temporary, 'package.json'), `${JSON.stringify({
      name: 'dsh-dependency-catalog', version: '0.0.0', private: true, dependencies: { [PACKAGE]: 'latest' },
    }, null, 2)}\n`)
    const environment = createNpmResolutionEnvironment(temporary)
    const npm = await runNpm(['--version'], temporary, environment)
    await runNpm([
      'install', '--package-lock-only', '--lockfile-version=3', '--ignore-scripts', '--no-audit', '--no-fund',
      '--include=prod', '--include=optional', '--include=peer', '--legacy-peer-deps=false',
      '--install-strategy=hoisted', '--loglevel=error', `--registry=${REGISTRY}`,
    ], temporary, environment)
    const lock = readFileSync(join(temporary, 'package-lock.json'), 'utf8')
    const metadata: ResolutionMetadata = {
      capturedAt: new Date().toISOString(), npm, node: process.versions.node,
      platform: process.platform, arch: process.arch, registry: REGISTRY, installStrategy: 'hoisted',
    }
    const catalog = renderCatalog(JSON.parse(lock), metadata)
    mkdirSync(resolve(ROOT, dirname(LOCK)), { recursive: true })
    writeFileSync(resolve(ROOT, LOCK), lock)
    writeFileSync(resolve(ROOT, METADATA), `${JSON.stringify(metadata, null, 2)}\n`)
    writeFileSync(resolve(ROOT, OUT), catalog)
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, refresh: { type: 'boolean' } } })
  if (values.check && values.refresh) throw new Error('dependency-catalog: --check cannot refresh the registry record')
  if (values.refresh) {
    await refreshResolution()
  } else if (values.check) {
    if (!isDependencyCatalogCurrent()) {
      throw new Error(`dependency-catalog: stale ${OUT}; run pnpm run gen-dependency-catalog`)
    }
    console.log('dependency-catalog: JSON matches the recorded npm resolution')
    return
  } else {
    writeFileSync(resolve(ROOT, OUT), computeDependencyCatalog())
  }
  console.log(`dependency-catalog: generated ${OUT}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
