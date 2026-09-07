/**
 * The three independent publish sequences this repository releases from
 * (`packages/` + `apps/`, `vendor/`, and `native/`) and the two this module
 * owns: `dsh` and `vendor`. Each family carries its own version baseline, tag
 * naming, and publish set, so releasing one never republishes another
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * The family dimension lives here only. A new sequence adds a subclass and a
 * `releaseFamilies()` entry; nothing else in the release scripts branches on it.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  officialClientBuildEnvironment,
  readClientBuildRecord,
} from '../client-build-environment.ts'
import { validateTarballPayload } from '../publication-payload.ts'

/**
 * Dependency sections a consumer must publish after, because npm resolves them
 * when the package is installed: publishing a consumer first would leave a
 * window where its own tree cannot be assembled.
 */
const INSTALL_SECTIONS = ['dependencies', 'optionalDependencies'] as const

/**
 * Peer declarations also order the publication, but they cannot constrain it.
 * npm never installs a peer on the package's behalf — an unmet peer is a
 * warning, not a resolution failure — and sibling packages legitimately declare
 * each other as peers, which makes these edges the ones that close cycles. They
 * order what they can and are dropped where they would deadlock.
 */
const PEER_SECTIONS = ['peerDependencies'] as const

/** The workspace root manifest, which is never a release member. */
const WORKSPACE_ROOT_PACKAGE = '@deepseek-ai/dsh-root'

/** One peer declaration the publish order leaves unordered. */
interface DroppedPeerEdge {
  readonly consumer: string
  /** The declared peer, which publishes after `consumer` or alongside it in a cycle. */
  readonly peer: string
}

/**
 * A family's publish order together with the ordering it could not honour.
 *
 * The dropped edges are part of the result rather than a detail of forming it:
 * a release drops real ordering constraints, and the operator reading the pack
 * log is the only one who can judge whether a newly dropped edge is expected.
 */
export interface PublishPlan {
  readonly order: readonly ReleaseMember[]
  /** Peer declarations left unordered, in the order the traversal reached them. */
  readonly droppedPeerEdges: readonly DroppedPeerEdge[]
}

/** One publishable package of a release family. */
export interface ReleaseMember {
  readonly directory: string
  readonly name: string
  readonly version: string
  readonly manifest: Readonly<Record<string, unknown>>
}

/**
 * Read and parse a JSON file.
 * @param path - absolute file path.
 * @returns The parsed object.
 */
function readManifest(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Read a required string field.
 * @param manifest - parsed manifest.
 * @param field - field name.
 * @param context - manifest path for the error message.
 * @returns The field value.
 */
function requireString(manifest: Record<string, unknown>, field: string, context: string): string {
  const value = manifest[field]
  if (typeof value !== 'string' || value === '') throw new Error(`${context} must declare a string ${field}`)
  return value
}

/** The executable a family's installed artifacts are driven through. */
export interface InstalledEntry {
  readonly packageName: string
  readonly binPath: string
}

/** A release sequence: its members, its version baseline, and its tag naming. */
export abstract class ReleaseFamily {
  /** Workflow-facing `--family` identifier. */
  abstract readonly id: string

  /** Repository-relative glob patterns selecting this family's manifests. */
  abstract readonly patterns: readonly string[]

  /** Git tag prefix this family publishes from. */
  abstract readonly tagPrefix: string

  /**
   * Assert that built artifacts match this release family's required profile.
   * Families without environment-selected artifacts accept every build tree.
   * @param _root - repository root containing generated artifacts.
   */
  verifyBuildArtifacts(_root: string): void {}

  /**
   * Discover this family's members.
   * @param root - repository root.
   * @returns Publishable members sorted by directory, with names validated and deduplicated.
   */
  members(root: string): ReleaseMember[] {
    const manifestPaths = globSync([...this.patterns], { cwd: root }).sort()
    if (manifestPaths.length === 0) throw new Error(`release family ${this.id} matched no manifests`)

    const members: ReleaseMember[] = []
    const seen = new Set<string>()
    for (const manifestPath of manifestPaths) {
      const normalized = manifestPath.replaceAll('\\', '/')
      const manifest = readManifest(resolve(root, manifestPath))
      if (manifest.private === true) continue
      const name = requireString(manifest, 'name', normalized)
      const version = requireString(manifest, 'version', normalized)
      if (name === WORKSPACE_ROOT_PACKAGE) throw new Error(`${normalized} selected the workspace root`)
      if (!name.startsWith('@deepseek-ai/')) throw new Error(`${normalized} must name an @deepseek-ai package`)
      if (seen.has(name)) throw new Error(`${name} appears twice in release family ${this.id}`)
      seen.add(name)
      members.push({
        directory: normalized.slice(0, normalized.length - '/package.json'.length),
        name,
        version,
        manifest,
      })
    }
    return members
  }

  /**
   * Order members so every package publishes after the family members it
   * depends on, which is what makes a partial publication self-consistent: an
   * interrupted run leaves a prefix whose packages never point at something
   * absent from the registry.
   *
   * Install edges are honoured absolutely — a cycle among them is a defect this
   * reports rather than works around. Peer edges order what they can and are
   * dropped where honouring one would deadlock: sibling packages declare each
   * other as peers, and npm treats an unmet peer as a warning rather than a
   * resolution failure ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
   * Every dropped edge is reported, because dropping one is a decision about a
   * real release rather than an implementation detail.
   * @param members - this family's members.
   * @returns The order, ties broken by name for determinism, and the peer edges it left unordered.
   */
  publishOrder(members: readonly ReleaseMember[]): PublishPlan {
    const byName = new Map(members.map(member => [member.name, member]))
    const byNameSorted = [...members].sort((left, right) => left.name.localeCompare(right.name))
    const edges = (member: ReleaseMember, sections: readonly string[]): ReleaseMember[] =>
      this.orderEdges(member, byName, sections)

    // Install edges alone must be acyclic, and that is checked on its own graph:
    // a peer edge leading into an install edge would otherwise read as a cycle
    // where the install edges are perfectly orderable.
    const installVisiting = new Set<string>()
    const installDone = new Set<string>()
    const checkInstall = (member: ReleaseMember, path: readonly string[]): void => {
      if (installDone.has(member.name)) return
      if (installVisiting.has(member.name)) {
        throw new Error(`dependency cycle in release family ${this.id}: ${[...path, member.name].join(' -> ')}`)
      }
      installVisiting.add(member.name)
      for (const dependency of edges(member, INSTALL_SECTIONS)) checkInstall(dependency, [...path, member.name])
      installVisiting.delete(member.name)
      installDone.add(member.name)
    }
    for (const member of byNameSorted) checkInstall(member, [])

    // Emit the order over both kinds of edge. A node already on the stack closes
    // a cycle, and that cycle carries at least one peer edge because the install
    // edges were just proved acyclic — but the back edge that reaches the stacked
    // node is not necessarily the peer one, so the post-condition below decides
    // whether the emitted order survived.
    const ordered: ReleaseMember[] = []
    const droppedPeerEdges: DroppedPeerEdge[] = []
    const placed = new Set<string>()
    const onStack = new Set<string>()
    // Members reachable from one member through install edges. A peer edge is
    // dropped when the peer installs the member declaring it: honouring it would
    // emit a package before something it installs, and the install edge wins.
    const installClosure = (member: ReleaseMember): Set<string> => {
      const reached = new Set<string>()
      const walk = (current: ReleaseMember): void => {
        for (const dependency of edges(current, INSTALL_SECTIONS)) {
          if (reached.has(dependency.name)) continue
          reached.add(dependency.name)
          walk(dependency)
        }
      }
      walk(member)
      return reached
    }
    const visit = (member: ReleaseMember): void => {
      if (placed.has(member.name) || onStack.has(member.name)) return
      onStack.add(member.name)
      for (const dependency of edges(member, INSTALL_SECTIONS)) visit(dependency)
      for (const peer of edges(member, PEER_SECTIONS)) {
        if (installClosure(peer).has(member.name)) {
          droppedPeerEdges.push({ consumer: member.name, peer: peer.name })
          continue
        }
        // A peer already on the stack is an ancestor, so it publishes after this
        // member rather than before it: the edge is dropped, not honoured.
        if (onStack.has(peer.name)) droppedPeerEdges.push({ consumer: member.name, peer: peer.name })
        visit(peer)
      }
      onStack.delete(member.name)
      placed.add(member.name)
      ordered.push(member)
    }
    for (const member of byNameSorted) visit(member)

    // A cycle mixing both kinds of edge can put an install edge's target on the
    // stack, where the traversal skips it like a peer edge and emits a consumer
    // before something it installs. Nothing downstream can detect that, and it
    // would only surface as an unresolvable install for whoever consumes the
    // published packages, so the emitted order is checked against the edges it
    // exists to honour.
    const position = new Map(ordered.map((entry, index) => [entry.name, index]))
    for (const [index, member] of ordered.entries()) {
      for (const dependency of edges(member, INSTALL_SECTIONS)) {
        const dependencyIndex = position.get(dependency.name)
        if (dependencyIndex !== undefined && dependencyIndex < index) continue
        throw new Error(
          `release family ${this.id}: no publish order honours ${member.name} -> ${dependency.name};`
          + ' a cycle mixing peer and dependency declarations reaches this dependency through a peer edge',
        )
      }
    }
    return { order: ordered, droppedPeerEdges }
  }

  /**
   * The family members one member declares in the given sections.
   * @param member - the dependent member.
   * @param byName - every family member by package name.
   * @param sections - manifest sections to read.
   * @returns Members of this family named there, sorted by name.
   */
  private orderEdges(
    member: ReleaseMember,
    byName: ReadonlyMap<string, ReleaseMember>,
    sections: readonly string[],
  ): ReleaseMember[] {
    const edges: ReleaseMember[] = []
    for (const section of sections) {
      const dependencies = member.manifest[section]
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
      for (const name of Object.keys(dependencies)) {
        const dependency = byName.get(name)
        if (dependency !== undefined && dependency.name !== member.name) edges.push(dependency)
      }
    }
    return edges.sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Assert this family's version baseline holds across its members.
   * @param members - this family's members.
   */
  abstract verifyVersions(members: readonly ReleaseMember[]): void

  /**
   * The tag prefix a member's versions are tagged under. Every tag for that
   * member starts with it, which is how the last published version is found.
   * @param member - the member being published.
   * @returns The prefix, ending in `-v`.
   */
  abstract tagPrefixFor(member: ReleaseMember): string

  /**
   * The npm dist-tag assigned while publishing a version.
   * @param version - package version from the packed manifest.
   * @returns `next` for a prerelease, or undefined so npm uses `latest`.
   */
  distTagForVersion(version: string): string | undefined {
    return version.includes('-') ? 'next' : undefined
  }

  /**
   * The tag a member publishes from.
   * @param member - the member being published.
   * @returns The full tag name, without `refs/tags/`.
   */
  tagFor(member: ReleaseMember): string {
    return `${this.tagPrefixFor(member)}${member.version}`
  }

  /**
   * Check what a member's packed tarball carries.
   * @param member - the packed member.
   * @param files - every path inside its tarball.
   */
  abstract validatePayload(member: ReleaseMember, files: readonly string[]): void

  /**
   * The executable that proves this family's artifacts install and run, or
   * `undefined` for a family that publishes no executable.
   */
  abstract readonly installedEntry: InstalledEntry | undefined
}

/** Release packages and apps: one shared version across the whole family. */
class DshFamily extends ReleaseFamily {
  readonly id = 'dsh'
  readonly patterns = ['packages/!(experimental)/*/package.json', 'apps/*/package.json'] as const
  readonly tagPrefix = 'dsh-v'

  /** Require current artifacts from a complete official client build. */
  override verifyBuildArtifacts(root: string): void {
    readClientBuildRecord(root, officialClientBuildEnvironment(root))
  }

  /**
   * Require one version across the family, the way a single tag can name it.
   * @param members - this family's members.
   */
  verifyVersions(members: readonly ReleaseMember[]): void {
    const versions = new Set(members.map(member => member.version))
    if (versions.size !== 1) {
      const detail = members.map(member => `${member.directory}: ${member.version}`).join('\n')
      throw new Error(`dsh release members must share one version:\n${detail}`)
    }
  }

  /**
   * The single family prefix: every member shares one version, so one tag names it.
   * @returns `dsh-v`.
   */
  tagPrefixFor(): string {
    return this.tagPrefix
  }

  override distTagForVersion(version: string): string | undefined {
    const separator = version.indexOf('-')
    if (separator === -1) return undefined
    const [channel] = version.slice(separator + 1).split('.')
    if (channel === 'alpha' || channel === 'canary') return channel
    return 'next'
  }

  /**
   * Reject source and declaration-map members, the repository's publication policy.
   * @param member - the packed member.
   * @param files - every path inside its tarball.
   */
  validatePayload(member: ReleaseMember, files: readonly string[]): void {
    validateTarballPayload(files, member.name)
  }

  readonly installedEntry = { packageName: '@deepseek-ai/dsh', binPath: 'lib/bin.js' }
}

/** `vendor/*`: every package keeps its own version line, so every package has its own tag. */
class VendorFamily extends ReleaseFamily {
  readonly id = 'vendor'
  readonly patterns = ['vendor/*/package.json'] as const
  readonly tagPrefix = 'vendor-'

  /**
   * Accept independent versions; only reject a version this repository cannot publish.
   * @param members - this family's members.
   */
  verifyVersions(members: readonly ReleaseMember[]): void {
    for (const member of members) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(member.version)) {
        throw new Error(`${member.directory} has an unpublishable version: ${member.version}`)
      }
    }
  }

  /**
   * A prefix per member, because one vendor release can carry several versions.
   * @param member - the member being published.
   * @returns `vendor-<unscoped name>-v`.
   */
  tagPrefixFor(member: ReleaseMember): string {
    return `${this.tagPrefix}${member.name.replace('@deepseek-ai/', '')}-v`
  }

  /**
   * Require the payload the vendored manifest declares, including upstream's
   * `src` tree and declaration maps.
   *
   * The harness policy that rejects both does not apply here: these manifests
   * export `./src/*` for source navigation, so dropping `src` would publish a
   * package whose export map points at absent files. What must hold instead is
   * that every path the manifest selects is present, which `files` already
   * decides and `pnpm pack` already enforces.
   * @param member - the packed member.
   * @param files - every path inside its tarball.
   */
  validatePayload(member: ReleaseMember, files: readonly string[]): void {
    if (files.length === 0) throw new Error(`${member.name} packed an empty tarball`)
  }

  /** No installed-entry probe: these are libraries a consumer imports, with no executable. */
  readonly installedEntry = undefined
}

/** Every release family this module owns, in workflow order. */
function releaseFamilies(): readonly ReleaseFamily[] {
  return [new DshFamily(), new VendorFamily()]
}

/**
 * Resolve a family by its `--family` identifier.
 * @param id - family identifier.
 * @returns The family.
 */
export function releaseFamily(id: string): ReleaseFamily {
  const family = releaseFamilies().find(candidate => candidate.id === id)
  if (family === undefined) {
    const known = releaseFamilies().map(candidate => candidate.id).join(', ')
    throw new Error(`unknown release family ${id}; expected one of ${known}`)
  }
  return family
}

/**
 * The npm tarball filename `pnpm pack` writes for a member.
 * @param member - the packed member.
 * @returns The tarball filename.
 */
export function tarballName(member: ReleaseMember): string {
  const unscoped = member.name.startsWith('@') ? member.name.slice(1).replace('/', '-') : member.name
  return `${unscoped}-${member.version}.tgz`
}
