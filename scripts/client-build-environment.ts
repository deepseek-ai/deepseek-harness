import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Prefix reserved for build-time values that may be embedded in browser artifacts. */
const CLIENT_BUILD_ENV_PREFIX = 'DSH_CLIENT_'

/** Non-public selector used by build orchestration to request a named client profile. */
export const CLIENT_BUILD_PROFILE_SELECTOR = 'DSH_BUILD_CLIENT_PROFILE'

/** Public client environment required by official DSH artifacts. */
const OFFICIAL_CLIENT_BUILD_ENVIRONMENT = {
  DSH_CLIENT_BUILD_PROFILE: 'official',
  DSH_CLIENT_TITLE: 'DeepSeek Harness',
} as const

/** Public variable carrying the source commit embedded in client artifacts. */
const CLIENT_COMMIT_HASH_VARIABLE = 'DSH_CLIENT_COMMIT_HASH'

/** Public variable carrying the repository package version embedded in client artifacts. */
const CLIENT_VERSION_VARIABLE = 'DSH_CLIENT_VERSION'

/** Repository-relative path of the complete client build record. */
export const CLIENT_BUILD_RECORD_PATH = '.dsh-build/client-build-environment.json'

const CLIENT_BUILD_RECORD_FORMAT = 1
const CLIENT_ARTIFACT_PATTERNS = [
  'apps/web/dist/**/*',
  'packages/*/*/lib/client.js',
  'packages/*/*/lib/client.js.map',
  'packages/*/*/lib/client.*.js',
  'packages/*/*/lib/client.*.js.map',
] as const

/** Public values embedded in one set of client artifacts. */
export type ClientBuildEnvironment = Readonly<Record<string, string>>

/**
 * Resolve the short source commit used by browser build metadata.
 * @param root - repository root used when no explicit value is supplied.
 * @param environment - environment that may already carry a commit value.
 * @returns lowercase 7-character Git commit prefix.
 */
export function repositoryCommitHash(root: string, environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment[CLIENT_COMMIT_HASH_VARIABLE]
  const value = explicit ?? execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[0-9a-f]{7,40}$/iu.test(value)) {
    throw new Error(`${CLIENT_COMMIT_HASH_VARIABLE} must be a Git commit hash; got ${JSON.stringify(value)}`)
  }
  return value.slice(0, 7).toLowerCase()
}

/**
 * Resolve the repository package version used by browser build metadata.
 * @param root - repository root containing the authoritative package.json.
 * @returns the repository's semver-compatible package version.
 */
export function repositoryVersion(root: string): string {
  const path = resolve(root, 'package.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read repository version from ${path}: ${detail}`)
  }
  if (!isObject(manifest) || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`repository package.json has an invalid version ${JSON.stringify(isObject(manifest) ? manifest.version : undefined)}`)
  }
  return manifest.version
}

/**
 * Read whether Git reports any staged, unstaged, untracked, or submodule change.
 * @param root - repository root whose worktree is inspected.
 * @returns true or false inside a Git worktree; undefined without Git metadata.
 */
export function repositoryGitDirty(root: string): boolean | undefined {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (probe.error !== undefined || probe.status !== 0 || probe.stdout.trim() !== 'true') return undefined

  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (status.error !== undefined) throw status.error
  if (status.status !== 0) {
    throw new Error(`git status failed in ${root}: ${status.stderr.trim() || String(status.status)}`)
  }
  return status.stdout !== ''
}

/**
 * Resolve the public environment for a complete default build from one checkout.
 * Repository-owned metadata replaces inherited values; other public values pass through.
 * @param root - repository root supplying version and Git metadata.
 * @param environment - caller environment supplying optional commit and public extensions.
 * @returns complete public client environment for the default build.
 */
export function repositoryClientBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): ClientBuildEnvironment {
  const inherited = { ...clientBuildEnvironment(environment) }
  delete inherited.DSH_CLIENT_COMMIT_HASH
  delete inherited.DSH_CLIENT_GIT_DIRTY
  delete inherited.DSH_CLIENT_VERSION
  const dirty = repositoryGitDirty(root)
  return {
    ...inherited,
    DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, environment),
    ...(dirty === true ? { DSH_CLIENT_GIT_DIRTY: 'true' } : {}),
    DSH_CLIENT_VERSION: repositoryVersion(root),
  }
}

/**
 * Resolve the exact public values required by an official build at one commit.
 * @param root - repository root whose HEAD must match the built source.
 * @param environment - optional explicit commit source for non-Git build environments.
 * @returns complete official client environment.
 */
export function officialClientBuildEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<`DSH_CLIENT_${string}`, string>> {
  return {
    DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, environment),
    DSH_CLIENT_VERSION: repositoryVersion(root),
    ...OFFICIAL_CLIENT_BUILD_ENVIRONMENT,
  }
}

/** Digest of every client artifact produced by the complete root build. */
interface ClientArtifactDigest {
  /** Number of files covered by the digest. */
  readonly fileCount: number
  /** Lowercase SHA-256 digest of sorted paths and file contents. */
  readonly sha256: string
}

/** Durable description of one complete root client build. */
export interface ClientBuildRecord {
  /** Record schema version. */
  readonly formatVersion: number
  /** Exact public environment embedded by Vite and tsdown. */
  readonly environment: ClientBuildEnvironment
  /** Digest that binds the environment to the current artifacts. */
  readonly artifacts: ClientArtifactDigest
}

/**
 * Collect the public client environment in deterministic key order.
 * @param environment - environment inherited by the build process.
 * @returns defined `DSH_CLIENT_*` values only.
 */
function clientBuildEnvironment(environment: NodeJS.ProcessEnv): ClientBuildEnvironment {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => name.startsWith(CLIENT_BUILD_ENV_PREFIX) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>
}

/**
 * Resolve the exact public environment selected for a complete client build.
 * @param environment - parent process environment.
 * @param profile - explicit profile, or the non-public selector when omitted.
 * @returns the inherited public values when no profile is selected, otherwise the named profile.
 */
export function resolveClientBuildEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: string | undefined = environment[CLIENT_BUILD_PROFILE_SELECTOR],
): ClientBuildEnvironment {
  if (profile === undefined) return clientBuildEnvironment(environment)
  if (profile === 'official') {
    const commitHash = environment[CLIENT_COMMIT_HASH_VARIABLE]
    const version = environment[CLIENT_VERSION_VARIABLE]
    if (commitHash === undefined) {
      throw new Error(`${CLIENT_COMMIT_HASH_VARIABLE} is required for the official client build profile`)
    }
    if (version === undefined) {
      throw new Error(`${CLIENT_VERSION_VARIABLE} is required for the official client build profile`)
    }
    return {
      DSH_CLIENT_COMMIT_HASH: commitHash,
      DSH_CLIENT_VERSION: version,
      ...OFFICIAL_CLIENT_BUILD_ENVIRONMENT,
    }
  }
  throw new Error(`unknown client build profile ${JSON.stringify(profile)}; expected "official"`)
}

/**
 * Construct a subprocess environment containing exactly the selected public values.
 * @param environment - parent process environment.
 * @param clientEnvironment - complete public environment selected for the build.
 * @returns the parent environment with selectors and inherited public values replaced.
 */
export function clientBuildProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  clientEnvironment: ClientBuildEnvironment,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (name === CLIENT_BUILD_PROFILE_SELECTOR || name.startsWith(CLIENT_BUILD_ENV_PREFIX)) continue
    child[name] = value
  }
  return { ...child, ...clientEnvironment }
}

/**
 * Require the public client environment to match an artifact profile exactly.
 *
 * An exact key set matters because every prefixed value is eligible for
 * inlining: an unexpected variable can change published bytes just as surely
 * as a missing or incorrect required value.
 *
 * @param environment - public environment from a build process or build record.
 * @param expected - complete public client environment for the artifact profile.
 */
export function assertClientBuildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<`DSH_CLIENT_${string}`, string>>,
): void {
  const actual = Object.fromEntries(Object.entries(environment)
    .filter(([name, value]) => name.startsWith(CLIENT_BUILD_ENV_PREFIX) && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)))
  const normalizedExpected = Object.fromEntries(Object.entries(expected)
    .sort(([left], [right]) => left.localeCompare(right)))
  if (JSON.stringify(actual) === JSON.stringify(normalizedExpected)) return

  const names = [...new Set([...Object.keys(actual), ...Object.keys(normalizedExpected)])].sort()
  const differences = names.filter(name => actual[name] !== normalizedExpected[name])
  throw new Error(`client build environment differs from the required artifact profile: ${differences.join(', ')}`)
}

/**
 * Create bundler substitutions for public client build environment variables.
 *
 * The empty `process.env` fallback makes an unset static property read
 * evaluate to `undefined` without providing a browser `process` global.
 * Exact substitutions remain longer matches than that fallback. Dynamic
 * property reads and enumeration deliberately observe the empty object.
 *
 * @param environment - environment inherited by the build process.
 * @returns deterministic Vite/tsdown `define` expressions.
 */
export function clientBuildEnvironmentDefines(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const defines: Record<string, string> = { 'process.env': '{}' }
  for (const [name, value] of Object.entries(clientBuildEnvironment(environment))) {
    defines[`process.env.${name}`] = JSON.stringify(value)
  }
  return defines
}

/**
 * Write the build record after a complete root build succeeds.
 * @param root - repository root containing the generated artifacts.
 * @param environment - exact public environment supplied to both bundlers.
 * @returns the record written to disk.
 */
export function writeClientBuildRecord(
  root: string,
  environment: ClientBuildEnvironment,
): ClientBuildRecord {
  const record: ClientBuildRecord = {
    formatVersion: CLIENT_BUILD_RECORD_FORMAT,
    environment: clientBuildEnvironment(environment),
    artifacts: clientArtifactDigest(root),
  }
  const path = resolve(root, CLIENT_BUILD_RECORD_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/**
 * Read a complete build record and prove it still describes the current artifacts.
 * @param root - repository root containing the record and generated artifacts.
 * @param expected - optional exact public environment required by a consumer.
 * @returns the parsed and artifact-verified record.
 */
export function readClientBuildRecord(
  root: string,
  expected?: Readonly<Record<`DSH_CLIENT_${string}`, string>>,
): ClientBuildRecord {
  const path = resolve(root, CLIENT_BUILD_RECORD_PATH)
  if (!existsSync(path)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} is missing; run a complete pnpm run build first`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} is invalid JSON: ${detail}`)
  }
  const record = parseClientBuildRecord(parsed)
  if (expected !== undefined) assertClientBuildEnvironment(record.environment, expected)

  const current = clientArtifactDigest(root)
  if (current.fileCount !== record.artifacts.fileCount || current.sha256 !== record.artifacts.sha256) {
    throw new Error(
      `client artifacts differ from ${CLIENT_BUILD_RECORD_PATH}; run a complete pnpm run build before consuming them`,
    )
  }
  return record
}

/** Return the deterministic digest of every artifact affected by the public client environment. */
function clientArtifactDigest(root: string): ClientArtifactDigest {
  const paths = globSync([...CLIENT_ARTIFACT_PATTERNS], { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => statSync(resolve(root, path)).isFile())
    .sort()
  if (paths.length === 0) throw new Error('complete client build produced no Vite or dynamic client artifacts')

  const digest = createHash('sha256')
  for (const path of paths) {
    const content = readFileSync(resolve(root, path))
    digest.update(`${Buffer.byteLength(path)}:`)
    digest.update(path)
    digest.update(`${content.byteLength}:`)
    digest.update(content)
  }
  return { fileCount: paths.length, sha256: digest.digest('hex') }
}

/** Parse and validate the persisted record before any consumer trusts it. */
function parseClientBuildRecord(value: unknown): ClientBuildRecord {
  if (!isObject(value) || !hasExactKeys(value, ['artifacts', 'environment', 'formatVersion'])) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid top-level schema`)
  }
  if (value.formatVersion !== CLIENT_BUILD_RECORD_FORMAT) {
    throw new Error(
      `client build record ${CLIENT_BUILD_RECORD_PATH} uses format ${String(value.formatVersion)}; expected ${String(CLIENT_BUILD_RECORD_FORMAT)}`,
    )
  }
  if (!isObject(value.environment)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid environment`)
  }
  const environment: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value.environment).sort(([left], [right]) => left.localeCompare(right))) {
    if (!name.startsWith(CLIENT_BUILD_ENV_PREFIX) || typeof entry !== 'string') {
      throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid environment entry ${name}`)
    }
    environment[name] = entry
  }
  if (!isObject(value.artifacts) || !hasExactKeys(value.artifacts, ['fileCount', 'sha256'])) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid artifact digest`)
  }
  if (!Number.isSafeInteger(value.artifacts.fileCount) || Number(value.artifacts.fileCount) < 1) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid artifact count`)
  }
  if (typeof value.artifacts.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.artifacts.sha256)) {
    throw new Error(`client build record ${CLIENT_BUILD_RECORD_PATH} has an invalid SHA-256 digest`)
  }
  return {
    formatVersion: CLIENT_BUILD_RECORD_FORMAT,
    environment,
    artifacts: {
      fileCount: Number(value.artifacts.fileCount),
      sha256: value.artifacts.sha256,
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
