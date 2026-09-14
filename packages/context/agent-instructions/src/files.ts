/**
 * Instruction-file discovery and bounded, abort-aware provider reads.
 *
 * @module @deepseek-ai/dsh-agent-instructions/files
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileSystem, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { dshHomeDisplay } from '@deepseek-ai/dsh-home-paths'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig } from './config.ts'
import { trimmedInstructionDigest } from './digest.ts'
import {
  decodeScopeKey,
  renderAgentInstructionSet,
  type RenderedAgentInstructions,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_FILE,
} from './render.ts'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

/** Provider metadata for a probed scope candidate before its content is read. */
export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  dshHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  projectRoot?: string
  signal?: AbortSignal
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
  replacePreviousBaseline?: boolean
}

/** Rendered baseline plus the successfully read and byte-budget-retained files. */
export interface RenderedInstructionSet {
  rendered: RenderedAgentInstructions
  /** Successfully read candidates before content deduplication and byte budgeting. */
  observed: LoadedInstructionFile[]
  /** Candidates retained by content deduplication and byte budgeting. */
  included: LoadedInstructionFile[]
}
/** Tri-state scope probe that distinguishes confirmed absence from provider failure. */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

interface StatFileInfo {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

type StatFileProbe =
  | { kind: 'present'; info: StatFileInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isMissingProviderPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND'
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<StatFileProbe> {
  try {
    signal?.throwIfAborted()
    // stat (not lstat) follows a final-component symlink so a link to a regular
    // file loads; a broken link surfaces as ENOENT and is treated as absent below.
    const info = await stat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return { kind: 'absent' }
    return { kind: 'present', info: { size: info.size } }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  // resolve() follows a final-component symlink to its target's stable identity;
  // stat then classifies that target. A link to a regular file loads, while a
  // missing path or non-file target (including a link to a directory) is absent.
  try {
    const target = await fileSystem.resolve(path, signalOptions(signal))
    signal?.throwIfAborted()
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type !== 'file') return { kind: 'absent' }
    return {
      kind: 'present',
      info: { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } },
    }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isMissingProviderPathError(error)) return false
      throw error
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 * @param cwd - absolute session working directory where the walk begins.
 * @param markers - child names that identify a project root.
 * @param fileSystem - optional provider used instead of host filesystem probes.
 * @param signal - cancellation for provider and host probes.
 * @returns the discovered project root, or `cwd` when no marker exists.
 * @throws the original marker metadata error or cancellation reason when a probe is unavailable.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive root-to-cwd directory chain.
 * @param root - root directory expected to contain or equal `cwd`.
 * @param cwd - most-specific directory in the chain.
 * @returns directories ordered from broadest to most specific.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Find descendant directories crossed between a cwd and a touched file.
 * @param root - session cwd that bounds nested discovery.
 * @param touchedPath - absolute path or path relative to `root`.
 * @returns descendant directories from shallowest through the touched file's parent.
 */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/**
 * Convert an absolute instruction path to its project-root-relative display form.
 * @param root - project root used as the display base.
 * @param path - absolute path to display.
 * @returns the root-relative path.
 */
export function relativeDisplay(root: string, path: string): string {
  return relative(root, path)
}

async function allExistingInstructionFiles(
  dir: string,
  root: string,
  instructionFileCandidates: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile[]> {
  const found: DiscoveredInstructionFile[] = []
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const probe = await statFile(path, fileSystem, signal)
    switch (probe.kind) {
      case 'present':
        found.push({ absolutePath: path, displayPath: relativeDisplay(root, path), ...probe.info })
        continue
      // A missing candidate is skipped; a transient provider failure skips only
      // that candidate so the remaining independent candidates still load.
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }
  return found
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile[]> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  const userGlobal = join(config.dshHome, USER_GLOBAL_FILE)
  const userGlobalProbe = await statFile(userGlobal, fileSystem, options.signal)
  switch (userGlobalProbe.kind) {
    case 'present':
      addFile({
        absolutePath: userGlobal,
        displayPath: userGlobalDisplayPath(config.dshHome),
        ...userGlobalProbe.info,
      })
      break
    case 'absent':
    case 'unavailable':
      break
    /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
    default:
      assertNever(userGlobalProbe, 'StatFileProbe')
  }

  const cwd = resolve(options.cwd)
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const file of await allExistingInstructionFiles(dir, projectRoot, candidates, fileSystem, options.signal)) {
        addFile(file)
      }
    }
  }
  return files
}

/**
 * Discover host-visible user-global and root-to-cwd instruction candidates.
 * All present candidates in each directory are returned; trimmed-content
 * duplicates are collapsed later, once content is read.
 * @param options - cwd, home, root marker, and candidate configuration.
 * @returns path-deduplicated instruction candidates in model precedence order.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  return (await discoverInstructionFiles(options)).map(({ absolutePath, displayPath }) => ({ absolutePath, displayPath }))
}

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: { absolutePath: string; target?: FsTarget; size?: number },
  maxSourceBytes: number,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // TODO(total-instruction-read-bound): enforce an aggregate source budget
  // across a complete baseline or reconciliation batch; the render budget is
  // applied only after every accepted file has been read under this per-file cap.
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) return undefined
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) return undefined
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/**
 * Drop later candidates whose trimmed content duplicates an earlier sibling in
 * the same directory. Different directories never collapse even when identical;
 * within one directory the earliest candidate in discovery order is kept and its
 * original bytes are rendered. A candidate that symlinks a sibling resolves to
 * the same content and collapses here like any byte-identical real file.
 * @param files - loaded files in discovery order.
 * @returns the retained files in the same order.
 */
export function dedupInstructionFilesByDirectory(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByDir = new Map<string, Set<string>>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    const dir = dirname(file.displayPath)
    let digests = keptDigestsByDir.get(dir)
    if (digests === undefined) {
      digests = new Set()
      keptDigestsByDir.set(dir, digests)
    }
    const digest = trimmedInstructionDigest(file.content)
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  return kept
}

/**
 * Discover, read, and render the baseline instruction chain.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered baseline context, or undefined when nothing can be loaded.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedAgentInstructions | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

/**
 * Load a baseline together with the files retained after rendering.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered context and retained files, an explicit empty replacement set, or undefined when empty or disabled.
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readBounded(file, config.maxSourceBytes, fileSystem, options.signal)
    if (content !== undefined) {
      loaded.push({
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        content,
        ...file.version === undefined ? {} : { version: file.version },
      })
    }
  }
  const deduped = dedupInstructionFilesByDirectory(loaded)
  if (deduped.length === 0) {
    if (options.replacePreviousBaseline !== true) return undefined
    const { rendered, included } = renderAgentInstructionSet([], {
      maxBytes: config.maxBytes,
      replacePreviousBaseline: true,
    })
    return {
      rendered,
      observed: [],
      included,
    }
  }
  const { rendered, included } = renderAgentInstructionSet(deduped, {
    maxBytes: config.maxBytes,
    ...options.replacePreviousBaseline === undefined
      ? {}
      : { replacePreviousBaseline: options.replacePreviousBaseline },
  })
  return {
    rendered,
    observed: loaded,
    included,
  }
}

/**
 * Probe the current provider metadata for one per-candidate instruction scope.
 * @param scope - a {@link candidateScopeKey} identifying a directory and candidate file.
 * @param projectRoot - project root used to resolve and display project scopes.
 * @param resolved - normalized plugin configuration.
 * @param fileSystem - provider used to resolve and stat scope candidates.
 * @param signal - cancellation for provider probes.
 * @returns present metadata, confirmed absence, or temporary unavailability.
 */
export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const { directory, candidateName } = decodeScopeKey(scope)
  const dir = directory === USER_GLOBAL_DIRECTORY
    ? resolved.dshHome
    : directory === '.' ? projectRoot : join(projectRoot, directory)
  const absolutePath = join(dir, candidateName)
  // resolve() follows a final-component symlink; stat then classifies the target.
  // A non-file target (missing, or a link to a directory) is a confirmed absence;
  // only a provider exception is reported as unavailable.
  let target: FsTarget
  let info: FsInfo | undefined
  try {
    target = await fileSystem.resolve(absolutePath, signalOptions(signal))
    info = await fileSystem.stat(target, signal)
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
  if (info?.type !== 'file') return { kind: 'absent' }
  const file: ProbedInstructionFile = {
    absolutePath,
    displayPath: directory === USER_GLOBAL_DIRECTORY ? userGlobalDisplayPath(resolved.dshHome) : relativeDisplay(projectRoot, absolutePath),
    target,
    version: info.version,
    ...info.size === undefined ? {} : { size: info.size },
  }
  return { kind: 'present', file }
}

/**
 * Read one already-probed scope candidate under the configured source cap.
 * @param file - winning provider candidate and its metadata snapshot.
 * @param maxSourceBytes - maximum UTF-8 bytes accepted from the source.
 * @param fileSystem - provider used for the streaming read.
 * @param signal - cancellation for provider streaming.
 * @returns loaded content with the probed version, or undefined when unavailable.
 */
export async function readScopeInstruction(
  file: ProbedInstructionFile,
  maxSourceBytes: number,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  const content = await readBounded(file, maxSourceBytes, fileSystem, signal)
  if (content === undefined) return undefined
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content,
    version: file.version,
  }
}

function userGlobalDisplayPath(dshHome: string): string {
  return `${dshHomeDisplay(dshHome)}/AGENTS.md`
}
