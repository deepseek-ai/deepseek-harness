/**
 * Pack the local dependency closure of the Official on-demand bundles and serve
 * it as a loopback npm registry.
 *
 * A packaged application installs an Official bundle as `name@<running DSH
 * version>`, and the plugin manager asks a custom registry *alone*
 * ([registry plan](../packages/boot/plugin-manager/src/registry.ts)). Every
 * transitive dependency of the packed bundles must therefore be answerable by
 * this process: repository-owned packages come from the run's own artifacts,
 * and genuinely external packages keep npm's real metadata and bytes through a
 * fixed redirect. Publication is untouched; only one development run's
 * transport is local.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import yaml from 'js-yaml'
import semver from 'semver'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { capture, pnpmCommand } from './release/process.ts'
import { releaseFamily, tarballName, type ReleaseFamily, type ReleaseMember } from './release/families.ts'
import { packedManifest, tarballFiles } from './release/tarball.ts'

/** Run directories a registry invocation owns, relative to the repository root. */
export const REGISTRY_OUTPUT_ROOT = 'dist/test-bundles'

/** Manifest filename whose presence marks a run directory as complete. */
export const REGISTRY_MANIFEST_FILE = 'bundle-registry.json'

/** Registry every external package is redirected to, with the request path preserved. */
export const UPSTREAM_REGISTRY = 'https://registry.npmjs.org/'

/** Installation edges a consumer cannot load without. */
const REQUIRED_SECTIONS = ['dependencies'] as const

/** Edges pnpm may skip on this host; their packages still need local metadata. */
const OPTIONAL_SECTIONS = ['optionalDependencies'] as const

/** Edges that constrain an installation without installing on the package's behalf. */
const PEER_SECTIONS = ['peerDependencies'] as const

/** One workspace package available to pack and serve. */
export interface WorkspacePackage {
  /** Package name exactly as it is declared. */
  readonly name: string
  /** Absolute package directory. */
  readonly directory: string
  /** Parsed `package.json`. */
  readonly manifest: Record<string, unknown>
}

/** Platform constraints a package declares for its own artifacts. */
export interface PlatformConstraint {
  /** Accepted `process.platform` values, which may be `!value` negations. */
  readonly os?: readonly string[]
  /** Accepted `process.arch` values, which may be `!value` negations. */
  readonly cpu?: readonly string[]
  /** Accepted libc values on Linux, which may be `!value` negations. */
  readonly libc?: readonly string[]
}

/** One packed package archive the registry answers with. */
export interface BundleArtifact {
  /** Package name from the packed manifest. */
  readonly name: string
  /** Packed version, served exactly. */
  readonly version: string
  /** Absolute archive path in the run directory. */
  readonly archive: string
  /** Tarball filename inside the run directory. */
  readonly file: string
  /** Archive size in bytes, as served. */
  readonly bytes: number
  /** SHA-512 subresource integrity of the served bytes. */
  readonly integrity: string
  /** SHA-1 hex digest of the served bytes. */
  readonly shasum: string
  /** Manifest contained in the archive, which the registry serves as the version metadata. */
  readonly manifest: Record<string, unknown>
  /** Platform constraints the packed manifest declares for itself. */
  readonly platform: PlatformConstraint
  /** Dist tag this version publishes under, from its release family. */
  readonly distTag?: string
  /** When this run packed the archive; the only publication time the run can honestly claim. */
  readonly packedAt: string
}

/** The catalog roots together with the local packages an ordinary installation needs. */
export interface BundleSelection {
  /** Catalog roots, in admission order. */
  readonly entries: readonly string[]
  /** Local closure, sorted by package name. */
  readonly members: readonly WorkspacePackage[]
  /** Every repository-owned name, so a request for one is a local miss rather than an upstream redirect. */
  readonly workspaceNames: readonly string[]
  /** Members built for another platform, kept so pnpm reads their metadata and applies its own skip. */
  readonly foreignTargets: readonly string[]
}

/** What one run records beside its artifacts; the file is written only once the run is complete. */
export interface RegistryManifest {
  /** Manifest layout version. */
  readonly schemaVersion: 1
  /** Unique run directory name. */
  readonly buildId: string
  /** Which bytes these artifacts were packed from. */
  readonly source: {
    /** Full Git object id of the packed checkout. */
    readonly commit: string
    /** Whether the checkout had uncommitted changes, so the commit alone is not the snapshot. */
    readonly dirty: boolean
    /** Running DSH version the catalog installation target names. */
    readonly dshVersion: string
  }
  /** Catalog roots in admission order. */
  readonly entries: readonly string[]
  /** Every repository-owned name. */
  readonly workspaceNames: readonly string[]
  /** Packed packages, sorted by name. */
  readonly packages: readonly {
    readonly name: string
    readonly version: string
    readonly file: string
    readonly bytes: number
    readonly integrity: string
  }[]
}

/** A running loopback registry serving one immutable run directory. */
export interface BundleRegistry {
  /** Registry URL ending in the run's fresh namespace and a slash, as `--registry` takes it. */
  readonly url: string
  /** Stop dispatching, drop open connections, and resolve once the listener is gone. */
  close(): Promise<void>
}

/** One public release member and the family that owns its payload rules. */
export interface ReleaseEntry {
  /** Family owning this member's payload and version rules. */
  readonly family: ReleaseFamily
  /** The member as its family publishes it. */
  readonly member: ReleaseMember
}

/**
 * Resolve pnpm for a shell-free child process.
 *
 * A package script's own pnpm is authoritative, because it owns the workspace
 * lockfile and store; a direct invocation (`pnpm exec`, a test runner) has no
 * lifecycle environment, so the workspace's own pnpm dependency runs instead.
 * @param args - pnpm arguments.
 * @returns A command and argument array suitable for `spawn` without a shell.
 */
export function pnpmInvocationFor(args: readonly string[]): { command: string; args: string[] } {
  const entrypoint = process.env.npm_execpath
  // `npm run` and `yarn run` set the same variable; handing them pnpm's arguments would write a different lockfile.
  if (entrypoint !== undefined && /[\\/]pnpm[\\/]/u.test(entrypoint) && /\.[cm]?js$/u.test(entrypoint)) {
    return pnpmInvocation(args)
  }
  const [command, ...prefix] = pnpmCommand()
  return { command, args: [...prefix, ...args] }
}

/**
 * Read the pnpm workspace inventory.
 * @param root - repository root containing `pnpm-workspace.yaml`.
 * @returns Workspace packages indexed by name.
 */
export function readWorkspacePackages(root: string): Map<string, WorkspacePackage> {
  const settings: unknown = yaml.load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  if (!isRecord(settings)) throw new Error('pnpm-workspace.yaml must be a mapping')
  const patterns = settings.packages
  if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every(value => typeof value === 'string')) {
    throw new Error('pnpm-workspace.yaml must list package patterns')
  }
  const packages = new Map<string, WorkspacePackage>()
  const paths = globSync(patterns.map(pattern => `${pattern}/package.json`), { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .sort()
  for (const path of paths) {
    const manifest = manifestAt(join(root, path))
    const name = manifest.name
    if (typeof name !== 'string' || name === '') throw new Error(`${path} must declare a string name`)
    if (packages.has(name)) throw new Error(`duplicate workspace package ${name}`)
    packages.set(name, { name, directory: resolve(root, path, '..'), manifest })
  }
  if (packages.size === 0) throw new Error('the pnpm workspace inventory is empty')
  return packages
}

/**
 * Index the release families' public members by package name.
 * @param root - repository root containing the release families.
 * @returns Public release members keyed by package name.
 */
export function readReleaseMembers(root: string): Map<string, ReleaseEntry> {
  const members = new Map<string, ReleaseEntry>()
  for (const id of ['dsh', 'vendor']) {
    const family = releaseFamily(id)
    for (const member of family.members(root)) members.set(member.name, { family, member })
  }
  return members
}

/**
 * Assert each family's own version baseline, which is what one tag publishes.
 * @param root - repository root containing the release families.
 */
export function verifyReleaseVersions(root: string): void {
  for (const id of ['dsh', 'vendor']) {
    const family = releaseFamily(id)
    family.verifyVersions(family.members(root))
  }
}

/**
 * Require every catalog root to be a built, patch-carrying bundle in this checkout.
 *
 * The catalog generator already checks admission metadata; this checks the
 * artifacts a packed consumer would actually load, so a stale or partial build
 * fails before any archive is served.
 * @param options - catalog roots in admission order and the workspace inventory.
 */
export function verifyBuiltBundles(options: {
  readonly entries: readonly string[]
  readonly packages: ReadonlyMap<string, WorkspacePackage>
}): void {
  for (const name of options.entries) {
    const member = options.packages.get(name)
    if (member === undefined) throw new Error(`catalog entry ${name} is not a workspace package`)
    const main = member.manifest.main
    if (typeof main !== 'string' || main === '') throw new Error(`${name} declares no package main to load`)
    const entry = resolve(member.directory, main)
    if (!existsSync(entry) || !statSync(entry).isFile()) {
      throw new Error(`${name}: built runtime is missing at ${entry}; run pnpm run build:official first`)
    }
    const dsh = member.manifest.dsh
    if (!isRecord(dsh) || !isRecord(dsh.bundle)) throw new Error(`${name} declares no dsh.bundle`)
    const patches = declaredBundlePatches(member.manifest)
    if (patches.length === 0) throw new Error(`${name}: dsh.bundle.patch must be a file path or a list of file paths`)
    for (const patch of patches) {
      const path = join(member.directory, patch)
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name}: bundle patch ${path} is missing`)
    }
  }
}

/**
 * Read the platform constraints a manifest declares for its own artifacts.
 * @param manifest - package manifest.
 * @returns The declared `os`, `cpu`, and `libc` lists.
 */
export function platformConstraint(manifest: Record<string, unknown>): PlatformConstraint {
  const lists: { os?: readonly string[]; cpu?: readonly string[]; libc?: readonly string[] } = {}
  for (const field of ['os', 'cpu', 'libc'] as const) {
    const value = manifest[field]
    if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) lists[field] = value
  }
  return lists
}

/**
 * This host's platform values, for comparing against a package's own constraints.
 * @returns Host `os`, `cpu`, and libc.
 */
export function hostPlatform(): PlatformConstraint {
  if (process.platform !== 'linux') return { os: [process.platform], cpu: [process.arch] }
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
  return { os: [process.platform], cpu: [process.arch], libc: [report.header?.glibcVersionRuntime === undefined ? 'musl' : 'glibc'] }
}

/**
 * Whether a package's declared platform accepts this host.
 * @param constraint - declared constraints.
 * @param host - host `os`, `cpu`, and libc values.
 * @returns True when the package may run here.
 */
export function matchesPlatform(constraint: PlatformConstraint, host: PlatformConstraint): boolean {
  return allowsValue(constraint.os, host.os?.[0])
    && allowsValue(constraint.cpu, host.cpu?.[0])
    && allowsValue(constraint.libc, host.libc?.[0])
}

/**
 * Select the catalog roots and the local packages an ordinary installation needs.
 *
 * Every dependency naming a workspace package is followed, whatever its section
 * or protocol, so a locally owned requirement is never left to npm. A required
 * edge naming a package built for another platform fails here, because the run
 * cannot supply the artifact that installer would need; an optional edge is
 * kept so pnpm still reads its metadata and applies its own platform skip.
 * @param options - catalog roots, workspace inventory, and the host to judge platform edges against.
 * @returns The closure, the repository-owned names, and the foreign-target members it kept.
 */
export function selectBundleDependencies(options: {
  readonly entries: readonly string[]
  readonly packages: ReadonlyMap<string, WorkspacePackage>
  readonly platform: PlatformConstraint
}): BundleSelection {
  const { entries, packages, platform } = options
  if (entries.length === 0) throw new Error('the Official catalog has no on-demand entries')
  if (new Set(entries).size !== entries.length) throw new Error('Official catalog entries must be distinct')
  const selected = new Map<string, WorkspacePackage>()
  const parents = new Map<string, string>()
  const queued = new Set<string>()
  const queue: string[] = []
  const enqueue = (name: string, parent: string | undefined): void => {
    if (selected.has(name) || queued.has(name)) return
    queued.add(name)
    if (parent !== undefined) parents.set(name, parent)
    queue.push(name)
  }
  for (const entry of entries) enqueue(entry, undefined)
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index] as string
    const member = packages.get(name)
    if (member === undefined) {
      throw new Error(`local bundle closure cannot resolve workspace package ${name} (${dependencyPath(name, parents, entries)})`)
    }
    selected.set(name, member)
    for (const name of installedEdges(member.manifest)) {
      if (packages.has(name)) enqueue(name, member.name)
    }
  }

  const foreign: string[] = []
  for (const [name, member] of selected) {
    if (matchesPlatform(platformConstraint(member.manifest), platform)) continue
    if (reachedByRequiredEdge(name, entries, selected)) {
      throw new Error(
        `${dependencyPath(name, parents, entries)} requires ${name}, which targets`
        + ` ${describePlatform(platformConstraint(member.manifest))}; this host is ${describePlatform(platform)}.`
        + ' This run cannot supply a matching artifact for that package.',
      )
    }
    foreign.push(name)
  }

  return {
    entries: [...entries],
    members: [...selected.values()].sort((left, right) => left.name.localeCompare(right.name)),
    workspaceNames: [...packages.keys()].sort(),
    foreignTargets: foreign.sort(),
  }
}

/**
 * Pack the selected packages into one run directory and validate every archive
 * against the release family that owns it.
 * @param options - repository root, destination, selected members, and the public release index.
 * @returns Packed artifacts sorted by package name.
 */
export async function packBundleArtifacts(options: {
  readonly root: string
  readonly destination: string
  readonly members: readonly WorkspacePackage[]
  readonly release: ReadonlyMap<string, ReleaseEntry>
  readonly signal?: AbortSignal
}): Promise<BundleArtifact[]> {
  const { root, destination, members, release } = options
  if (members.length === 0) throw new Error('no local packages were selected to pack')
  await mkdir(destination, { recursive: true })
  const invocation = pnpmInvocationFor([
    'pack', '--recursive', `--workspace-concurrency=${String(Math.min(4, members.length))}`,
    ...members.map(member => `--filter=${member.name}`), '--pack-destination', destination,
  ])
  let result
  try {
    result = await execa(invocation.command, invocation.args, {
      cwd: root, reject: false, killDescendants: true,
      ...options.signal === undefined ? {} : { cancelSignal: options.signal },
    })
  } catch (error) {
    if (isCanceled(error)) throw new Error('packing was cancelled')
    throw error
  }
  if (result.isCanceled) throw new Error('packing was cancelled')
  if (result.exitCode !== 0) {
    throw new Error(`pnpm pack exited with ${String(result.exitCode ?? result.signal)}:\n${result.stdout}\n${result.stderr}`)
  }
  return readPackedArtifacts({ destination, members, release })
}

/**
 * Whether a settled or thrown child-process outcome was a cancellation.
 * @param value - the settled execa result or the error it rejected with.
 * @returns True when an abort signal ended the child.
 */
function isCanceled(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'isCanceled' in value && value.isCanceled === true
}

/**
 * Validate already packed archives and describe them as servable artifacts.
 * @param options - run directory, the members that were packed into it, and the public release index.
 * @returns Packed artifacts sorted by package name.
 */
export function readPackedArtifacts(options: {
  readonly destination: string
  readonly members: readonly WorkspacePackage[]
  readonly release: ReadonlyMap<string, ReleaseEntry>
}): BundleArtifact[] {
  const { destination, members, release } = options
  const packed = members.map((member) => {
    const entry = release.get(member.name)
    if (entry === undefined) {
      throw new Error(`${member.name}: not a public release member; the local registry does not republish a private or unreleased package`)
    }
    const file = tarballName(entry.member)
    const archive = join(destination, file)
    if (!existsSync(archive)) throw new Error(`${member.name} produced no tarball at ${archive}`)
    const contained = tarballFiles(archive)
    entry.family.validatePayload(entry.member, contained)
    const manifest = packedManifest(archive)
    entry.family.validatePackedManifest(entry.member, manifest)
    const main = manifest.main
    if (typeof main === 'string' && main !== '' && !contained.includes(`package/${payloadPath(main)}`)) {
      throw new Error(`${entry.member.name}: packed archive lacks its declared main ${main}; rebuild before serving`)
    }
    // A bundle whose patch is missing installs and then never loads its rows.
    for (const patch of declaredBundlePatches(manifest)) {
      if (!contained.includes(`package/${payloadPath(patch)}`)) {
        throw new Error(`${entry.member.name}: packed archive lacks its declared bundle patch ${patch}`)
      }
    }
    const bytes = readFileSync(archive)
    const distTag = entry.family.distTagForVersion(entry.member.version)
    return {
      name: entry.member.name,
      version: entry.member.version,
      archive,
      file,
      bytes: bytes.byteLength,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      manifest,
      platform: platformConstraint(manifest),
      ...distTag === undefined ? {} : { distTag },
      packedAt: new Date().toISOString(),
    }
  })
  verifyPackedClosure(packed)
  return packed.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Compose the record a completed run directory carries.
 * @param options - run identity, selection, artifacts, and source evidence.
 * @returns The manifest to write last.
 */
export function createRegistryManifest(options: {
  readonly buildId: string
  readonly source: RegistryManifest['source']
  readonly entries: readonly string[]
  readonly workspaceNames: readonly string[]
  readonly artifacts: readonly BundleArtifact[]
}): RegistryManifest {
  return {
    schemaVersion: 1,
    buildId: options.buildId,
    source: options.source,
    entries: [...options.entries],
    workspaceNames: [...options.workspaceNames],
    packages: [...options.artifacts]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(artifact => ({
        name: artifact.name,
        version: artifact.version,
        file: artifact.file,
        bytes: artifact.bytes,
        integrity: artifact.integrity,
      })),
  }
}

/**
 * Write the completion marker into a run directory.
 * @param path - absolute manifest path inside the run directory.
 * @param manifest - the record to serialize.
 */
export async function writeRegistryManifest(path: string, manifest: RegistryManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Record which checkout produced a run.
 * @param root - repository root.
 * @param dshVersion - running DSH version the catalog installation target names.
 * @returns The commit, whether the tree was dirty, and the version served.
 */
export function sourceEvidence(root: string, dshVersion: string): RegistryManifest['source'] {
  return {
    commit: capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
    dirty: capture('git', ['status', '--porcelain'], { cwd: root }) !== '',
    dshVersion,
  }
}

/**
 * Start the loopback registry for one run's artifacts.
 *
 * The listener binds `127.0.0.1` on an allocated port and answers under a fresh
 * namespace, so two runs never share a URL even when the port is reused.
 * @param options - the run's artifacts and directory, repository-owned names, and upstream registry.
 * @returns The registry URL and its close operation.
 */
export async function startBundleRegistry(options: {
  readonly directory: string
  readonly artifacts: readonly BundleArtifact[]
  readonly workspaceNames: readonly string[]
  readonly upstream?: string
}): Promise<BundleRegistry> {
  if (options.artifacts.length === 0) throw new Error('the local registry was started without artifacts')
  const upstream = options.upstream ?? UPSTREAM_REGISTRY
  if (!upstream.endsWith('/')) throw new Error(`upstream registry must end with a slash: ${upstream}`)
  const index = new Map(options.artifacts.map(artifact => [artifact.name, artifact]))
  const owned = new Set(options.workspaceNames)
  const namespace = randomUUID()
  // Assigned once the listener reports its allocated port; requests cannot arrive before then.
  let origin = ''
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET'
    const head = method === 'HEAD'
    if (method !== 'GET' && method !== 'HEAD') {
      respond(response, 405, { error: 'Method Not Allowed', reason: `${method} is not served` }, false)
      return
    }
    const raw = request.url ?? '/'
    const query = raw.indexOf('?')
    const path = query === -1 ? raw : raw.slice(0, query)
    const prefix = `/${namespace}/`
    if (!path.startsWith(prefix)) {
      respond(response, 404, { error: 'Not found', reason: 'request is outside this run\'s registry namespace' }, head)
      return
    }
    const suffix = path.slice(prefix.length)
    if (suffix.startsWith('tarballs/')) {
      serveTarball(suffix.slice('tarballs/'.length), response, head, options.directory, index)
      return
    }
    const requested = selection(suffix)
    if (requested === undefined) {
      respond(response, 404, { error: 'Not found', reason: 'malformed package path' }, head)
      return
    }
    const artifact = index.get(requested.name)
    if (artifact !== undefined) {
      serveMetadata(artifact, requested.version, response, head, origin)
      return
    }
    if (owned.has(requested.name)) {
      respond(response, 404, {
        error: 'Not found',
        reason: `${requested.name} is repository-owned but not part of this run's local closure; rebuild the registry after changing the catalog`,
      }, head)
      return
    }
    // Only package publication is local: third-party metadata and payloads keep npm's real bytes.
    response.writeHead(302, { location: `${upstream}${suffix}`, 'cache-control': 'no-store' })
    response.end()
  })

  const listening = new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.once('listening', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  server.listen({ port: 0, host: '127.0.0.1' })
  await listening
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('the local registry has no TCP address')
  }
  origin = `http://127.0.0.1:${String(address.port)}/${namespace}/`
  let closing: Promise<void> | undefined
  return {
    url: origin,
    close: () => {
      closing ??= closeServer(server)
      return closing
    },
  }
}

/**
 * Read a JSON manifest from disk.
 * @param path - absolute `package.json` path.
 * @returns The parsed object.
 */
function manifestAt(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`)
  return parsed
}

/**
 * Whether a parsed value is a JSON object.
 * @param value - value to inspect.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one dependency section as declared ranges.
 * @param manifest - package manifest.
 * @param section - section name.
 * @returns Name and range pairs, with malformed entries rejected.
 */
function dependencyRanges(manifest: Record<string, unknown>, section: string): [string, string][] {
  const value = manifest[section]
  if (value === undefined) return []
  if (!isRecord(value)) throw new Error(`${section} must be a mapping`)
  return Object.entries(value).map(([name, range]) => {
    if (typeof range !== 'string') throw new Error(`${section}.${name} must be a string range`)
    return [name, range]
  })
}

/**
 * Every package this manifest installs on a consumer: required, optional, and
 * required peers.
 * @param manifest - package manifest.
 * @returns Dependency names in section order.
 */
function installedEdges(manifest: Record<string, unknown>): string[] {
  const names = [...REQUIRED_SECTIONS, ...OPTIONAL_SECTIONS].flatMap(section => dependencyRanges(manifest, section).map(([name]) => name))
  for (const section of PEER_SECTIONS) {
    for (const [name] of dependencyRanges(manifest, section)) {
      if (!optionalPeer(manifest, name)) names.push(name)
    }
  }
  return names
}

/**
 * Whether a package opts out of a peer it declares.
 * @param manifest - package manifest.
 * @param name - peer package name.
 * @returns True when the peer is optional.
 */
function optionalPeer(manifest: Record<string, unknown>, name: string): boolean {
  const metadata = manifest.peerDependenciesMeta
  if (!isRecord(metadata)) return false
  const entry = metadata[name]
  return isRecord(entry) && entry.optional === true
}

/**
 * Whether one constrained value accepts the host's own value.
 * @param constraint - accepted values, which may be only `!value` negations.
 * @param current - the host's value, or undefined when the field does not apply here.
 * @returns True when the host value is allowed.
 */
function allowsValue(constraint: readonly string[] | undefined, current: string | undefined): boolean {
  if (constraint === undefined || constraint.length === 0) return true
  // A field the host does not have (libc off Linux) constrains nothing here.
  if (current === undefined) return true
  const positives = constraint.filter(value => !value.startsWith('!'))
  if (positives.length > 0 && !positives.includes('any') && !positives.includes(current)) return false
  return !constraint.includes(`!${current}`)
}

/**
 * Describe a platform constraint for a failure message.
 * @param constraint - declared or host constraints.
 * @returns A compact description.
 */
function describePlatform(constraint: PlatformConstraint): string {
  const parts = (['os', 'cpu', 'libc'] as const).flatMap(field => (constraint[field] ?? []).map(value => `${field}=${value}`))
  return parts.length === 0 ? 'any platform' : parts.join(' ')
}

/**
 * Whether any required edge reaches a package, ignoring optional and peer edges.
 * @param target - package to look for.
 * @param entries - catalog roots.
 * @param selected - the whole closure.
 * @returns True when a required dependency edge reaches the target.
 */
function reachedByRequiredEdge(target: string, entries: readonly string[], selected: ReadonlyMap<string, WorkspacePackage>): boolean {
  if (entries.includes(target)) return true
  const visited = new Set<string>()
  const pending = [...entries]
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index] as string
    if (visited.has(name)) continue
    visited.add(name)
    const member = selected.get(name)
    if (member === undefined) continue
    for (const section of REQUIRED_SECTIONS) {
      for (const [dependency] of dependencyRanges(member.manifest, section)) {
        if (dependency === target) return true
        if (selected.has(dependency)) pending.push(dependency)
      }
    }
  }
  return false
}

/**
 * Render the dependency path that reached a package, for a failure message.
 * @param name - the package being explained.
 * @param parents - the first edge that reached each package.
 * @param entries - catalog roots, which have no parent.
 * @returns A `root -> ... -> name` chain.
 */
function dependencyPath(name: string, parents: ReadonlyMap<string, string>, entries: readonly string[]): string {
  const chain = [name]
  let current = parents.get(name)
  while (current !== undefined) {
    chain.unshift(current)
    current = parents.get(current)
  }
  return chain.length === 1 && entries.includes(name) ? `catalog entry ${name}` : chain.join(' -> ')
}

/**
 * Normalize a manifest path or tarball member to its package-relative form, the
 * same rule the publication payload check applies.
 * @param file - manifest path or archive member.
 * @returns The package-relative path.
 */
function payloadPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\/+/u, '')
}

/**
 * The bundle patch files a manifest declares, as written.
 * @param manifest - packed or declared package manifest.
 * @returns Package-relative patch paths, or nothing when the package is not a bundle.
 */
function declaredBundlePatches(manifest: Record<string, unknown>): string[] {
  const dsh = manifest.dsh
  if (!isRecord(dsh) || !isRecord(dsh.bundle)) return []
  const declared = dsh.bundle.patch
  if (typeof declared === 'string') return [declared]
  return Array.isArray(declared) && declared.every(entry => typeof entry === 'string') ? declared : []
}

/**
 * Reject packed manifests that would send installation back to the checkout or
 * to a package this run does not serve.
 * @param artifacts - packed artifacts of one run.
 */
function verifyPackedClosure(artifacts: readonly BundleArtifact[]): void {
  const served = new Map(artifacts.map(artifact => [artifact.name, artifact]))
  for (const artifact of artifacts) {
    for (const section of [...REQUIRED_SECTIONS, ...OPTIONAL_SECTIONS, ...PEER_SECTIONS]) {
      for (const [name, range] of dependencyRanges(artifact.manifest, section)) {
        if (/^(?:workspace|file|link|portal):/u.test(range)) {
          throw new Error(`${artifact.name}: packed ${section}.${name} still declares ${range}`)
        }
        const local = served.get(name)
        if (local !== undefined && !semver.satisfies(local.version, range, { includePrerelease: true })) {
          throw new Error(`${artifact.name}: packed ${section}.${name} requires ${range}, but this run serves ${local.version}`)
        }
      }
    }
  }
}

/** The package a registry request path selects. */
interface PackageRequest {
  /** Package name, with its scope when it has one. */
  readonly name: string
  /** Exact version or dist tag the path asks for, absent for a packument request. */
  readonly version?: string
}

/**
 * Split a request path into the package name and version it selects.
 * @param suffix - the raw request path after the namespace.
 * @returns The selected package, or undefined when the path is not a package path.
 */
function selection(suffix: string): PackageRequest | undefined {
  const decoded = decodeSegment(suffix)
  if (decoded === undefined) return undefined
  const segments = decoded.split('/')
  // Reject traversal, registry administration paths, and empty segments before any name is considered.
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..') || segments[0]?.startsWith('-') === true) {
    return undefined
  }
  if (segments.length === 1 && segments[0] !== undefined) return { name: segments[0] }
  if (!decoded.startsWith('@')) {
    const [name, version] = segments
    return name !== undefined && version !== undefined && segments.length === 2 ? { name, version } : undefined
  }
  if (segments.length === 2) return { name: decoded }
  if (segments.length === 3) {
    const version = segments[2]
    return version === undefined ? undefined : { name: segments.slice(0, 2).join('/'), version }
  }
  return undefined
}

/**
 * Decode one percent-encoded path.
 * @param value - raw path text.
 * @returns The decoded text, or undefined when the encoding is malformed.
 */
function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Serve one archive's bytes from the artifact index.
 * @param file - raw requested tarball filename.
 * @param response - the response to write.
 * @param head - whether this is a HEAD request, whose body is omitted.
 * @param directory - the run directory holding the archives.
 * @param index - the run's artifact index.
 */
function serveTarball(
  file: string,
  response: ServerResponse,
  head: boolean,
  directory: string,
  index: ReadonlyMap<string, BundleArtifact>,
): void {
  const decoded = decodeSegment(file)
  const artifact = decoded === undefined ? undefined : [...index.values()].find(entry => entry.file === decoded)
  if (artifact === undefined) {
    respond(response, 404, { error: 'Not found', reason: 'no archive with that name in this run' }, head)
    return
  }
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(artifact.bytes),
    'cache-control': 'no-store',
  })
  if (head) {
    response.end()
    return
  }
  const stream = createReadStream(join(directory, artifact.file))
  // A client that disconnects mid-archive must not fail an unrelated request.
  response.on('close', () => stream.destroy())
  stream.on('error', (error) => { response.destroy(error) })
  stream.pipe(response)
}

/**
 * Serve the packument, a version document, or a dist-tag document for one artifact.
 * @param artifact - the artifact being described.
 * @param version - requested version or dist tag, or undefined for the whole packument.
 * @param response - the response to write.
 * @param head - whether this is a HEAD request, whose body is omitted.
 * @param origin - the run's registry URL.
 */
function serveMetadata(
  artifact: BundleArtifact,
  version: string | undefined,
  response: ServerResponse,
  head: boolean,
  origin: string,
): void {
  const tags: Record<string, string> = { latest: artifact.version }
  if (artifact.distTag !== undefined && artifact.distTag !== 'latest') tags[artifact.distTag] = artifact.version
  const document = {
    ...artifact.manifest,
    dist: {
      tarball: `${origin}tarballs/${encodeURIComponent(artifact.file)}`,
      integrity: artifact.integrity,
      shasum: artifact.shasum,
    },
  }
  if (version === undefined) {
    respond(response, 200, {
      name: artifact.name,
      'dist-tags': tags,
      versions: { [artifact.version]: document },
      time: { created: artifact.packedAt, modified: artifact.packedAt, [artifact.version]: artifact.packedAt },
    }, head)
    return
  }
  if (version !== artifact.version && !Object.hasOwn(tags, version)) {
    respond(response, 404, {
      error: 'Not found',
      reason: `this run serves ${artifact.name}@${artifact.version} only`,
    }, head)
    return
  }
  respond(response, 200, document, head)
}

/**
 * Write one JSON response.
 * @param response - the response to write.
 * @param status - HTTP status.
 * @param body - JSON body.
 * @param head - whether this is a HEAD request, whose body is omitted.
 */
function respond(response: ServerResponse, status: number, body: unknown, head: boolean): void {
  const text = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  response.end(head ? undefined : text)
}

/**
 * Close a server and everything it is still serving.
 * @param server - the listener to close.
 * @returns Resolves once the listener is gone.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.closeAllConnections()
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
}
