/**
 * Session-visible workspace instruction state and dynamic reconciliation.
 *
 * @module @deepseek-ai/dsh-agent-instructions/state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ResolvedConfig } from './config.ts'
import { instructionContentSha1, trimmedInstructionDigest } from './digest.ts'
import {
  ancestorChain,
  descendantDirsBetween,
  findProjectRoot,
  probeScopeInstruction,
  readScopeInstruction,
  relativeDisplay,
  scopeInstructionFile,
  type LoadedInstructionFile,
} from './files.ts'
import {
  candidateScopeKey,
  decodeScopeKey,
  instructionCandidateGroup,
  instructionScopeKey,
  isUserGlobalDirectory,
  renderInstructionChanges,
  USER_GLOBAL_DIRECTORIES,
  USER_GLOBAL_FILE,
  type ChangeRenderItem,
  type AgentInstructionChange,
} from './render.ts'

export const name = 'agent-instructions'

/** Durable producer, file, and reconciliation facts for one workspace context. */
export interface AgentInstructionSource {
  kind: 'agent-instructions'
  /** Every workspace context carries instructions read out of a file (the `instructions` context form). */
  form: 'instructions'
  /** Marks the complete startup/resume baseline rather than a later delta. */
  baseline?: true
  /** Discovery, precedence, and budget identity used to validate a resumed baseline. */
  baselineIdentity?: string
  changes: AgentInstructionChange[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-instructions': AgentInstructionSource
  }
}

/** Per-scope metadata cache; instruction prose is deliberately not retained. */
export interface InstructionVersionState {
  path: string
  version: FsVersion
  digest: string
  /**
   * Trimmed-content identity ({@link trimmedInstructionDigest}) used to suppress
   * candidate-group duplicates on the metadata fast path without re-reading a sibling.
   */
  trimmedDigest: string
}

/** Session-isolated fast-path state keyed by logical instruction scope. */
export type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>

/** A metadata-cache transition associated with one rendered instruction change. */
export interface InstructionVersionUpdate {
  change: AgentInstructionChange
  /** A duplicate-removal notice can retain metadata for its still-present file. */
  state?: InstructionVersionState
}

/** Rendered reconciliation plus its metadata-cache transitions. */
export interface ReconciledInstructionContext {
  context: UserMessage
  versionUpdates: InstructionVersionUpdate[]
}

function agentInstructionsHook(text: string, changes: AgentInstructionChange[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'agent-instructions', form: 'instructions', changes },
  })
}

/**
 * Build the user-role message for a rendered baseline.
 * @param text - complete plugin-owned system-reminder text.
 * @returns a user-role prefix message.
 */
export function agentInstructionsMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'instructions', changes: [] },
  })
}

function isAgentInstructionsSource(
  source: unknown,
): source is { kind: 'agent-instructions'; changes: unknown[] } {
  return typeof source === 'object' && source !== null
    && 'kind' in source && source.kind === 'agent-instructions'
    && 'changes' in source && Array.isArray(source.changes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceInstructionChanges(source: { changes: unknown[] }): AgentInstructionChange[] {
  const changes: AgentInstructionChange[] = []
  for (const value of source.changes) {
    if (!isRecord(value)) continue
    if (value.action !== 'set' && value.action !== 'replace' && value.action !== 'remove') continue
    if (typeof value.scope !== 'string' || typeof value.path !== 'string') continue
    if (value.digest !== undefined && typeof value.digest !== 'string') continue
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...value.digest !== undefined ? { digest: value.digest } : {},
    })
  }
  return changes
}

function sameInstructionChange(a: AgentInstructionChange, b: AgentInstructionChange): boolean {
  return a.action === b.action
    && a.scope === b.scope
    && a.path === b.path
    && a.digest === b.digest
}

function visibleInstructionChanges(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): Map<string, AgentInstructionChange> {
  const visible = new Map<string, AgentInstructionChange>()
  for (const seq of agent.session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message' || !isAgentInstructionsSource(event.data.source)) continue
    const changes = workspaceInstructionChanges(event.data.source)
    for (const change of changes) {
      visible.set(change.scope, change)
    }
  }
  for (const message of authorityMessages) {
    if (!isAgentInstructionsSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      visible.set(change.scope, change)
    }
  }
  return visible
}

/**
 * Convert retained baseline files into comparison and metadata-cache state.
 * @param files - baseline files that survived rendering.
 * @returns latest baseline changes and provider versions keyed by logical scope.
 */
export function baselineInstructionState(files: LoadedInstructionFile[]): {
  changes: Map<string, AgentInstructionChange>
  versions: Map<string, InstructionVersionState>
} {
  const changes = new Map<string, AgentInstructionChange>()
  const versions = new Map<string, InstructionVersionState>()
  for (const file of files) {
    const digest = instructionContentSha1(file.content)
    const change: AgentInstructionChange = {
      action: 'set',
      scope: instructionScopeKey(file.displayPath),
      path: file.displayPath,
      digest,
    }
    changes.set(change.scope, change)
    if (file.version !== undefined) {
      versions.set(change.scope, {
        path: file.displayPath,
        version: file.version,
        digest,
        trimmedDigest: trimmedInstructionDigest(file.content),
      })
    }
  }
  return { changes, versions }
}

function versionStatesFor(session: Session, cache: InstructionVersionCache): Map<string, InstructionVersionState> {
  let states = cache.get(session)
  if (states === undefined) {
    states = new Map()
    cache.set(session, states)
  }
  return states
}

/**
 * Keep only cache updates represented by rendered changes.
 * @param updates - proposed updates from one or more reconciliations.
 * @param renderedChanges - transitions retained by the renderer.
 * @returns updates represented by an exact retained transition.
 */
export function retainedInstructionVersionUpdates(
  updates: readonly InstructionVersionUpdate[],
  renderedChanges: readonly AgentInstructionChange[],
): InstructionVersionUpdate[] {
  return updates.filter(update => renderedChanges.some(change => sameInstructionChange(update.change, change)))
}

/**
 * Apply metadata-cache transitions without retaining instruction prose.
 * @param session - owning session.
 * @param updates - ordered set/delete transitions.
 * @param cache - session-isolated metadata cache.
 */
export function applyInstructionVersionUpdates(
  session: Session,
  updates: readonly InstructionVersionUpdate[],
  cache: InstructionVersionCache,
): void {
  if (updates.length === 0) return
  const states = versionStatesFor(session, cache)
  for (const update of updates) {
    if (update.state === undefined) states.delete(update.change.scope)
    else states.set(update.change.scope, update.state)
  }
  if (states.size === 0) cache.delete(session)
}

function relativeScope(projectRoot: string, dir: string): string {
  const scope = relativeDisplay(projectRoot, dir)
  return scope.length === 0 ? '.' : scope
}

/**
 * Compare visible state with provider-visible files and render transitions.
 * @param agent - session owner whose visible surface supplies durable state.
 * @param resolved - normalized plugin configuration.
 * @param versionCache - per-session scope metadata used to skip unchanged reads.
 * @param fileSystem - provider used for current file probes.
 * @param options - authoritative claimed context, pending scope hints, touched paths, and baseline participation.
 * @returns rendered context plus deferred cache updates, or undefined when unchanged/unavailable.
 */
export async function reconcileInstructionContext(
  agent: Agent,
  resolved: ResolvedConfig,
  versionCache: InstructionVersionCache,
  fileSystem: FileSystem,
  options: {
    cwd: string
    authorityMessages: readonly UserMessage[]
    scopeMessages: readonly UserMessage[]
    touchedPaths: readonly string[]
    includeBaselineScopes: boolean
    excludedBaselineScopes?: ReadonlySet<string>
    projectRoot?: string
    signal?: AbortSignal
  },
): Promise<ReconciledInstructionContext | undefined> {
  const session = agent.session
  const effective = visibleInstructionChanges(agent, options.authorityMessages)
  const cwd = options.cwd
  // TODO(frozen-project-root): retain the baseline root for the loop instance;
  // recomputing it after marker edits reinterprets the existing relative scope keys.
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, options.signal)
  const scopes = new Set<string>()
  const baselineScopes = new Set<string>()
  const addDirScopes = (target: Set<string>, directory: string): void => {
    for (const candidate of resolved.instructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
    for (const candidate of resolved.localInstructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
  }
  const addProjectScopes = (target: Set<string>, dir: string): void => {
    addDirScopes(target, relativeScope(projectRoot, dir))
  }
  for (const directory of USER_GLOBAL_DIRECTORIES) baselineScopes.add(candidateScopeKey(directory, USER_GLOBAL_FILE))
  for (const dir of ancestorChain(projectRoot, cwd)) addProjectScopes(baselineScopes, dir)
  if (options.includeBaselineScopes) {
    for (const scope of baselineScopes) scopes.add(scope)
  }
  for (const message of options.scopeMessages) {
    /* v8 ignore next -- the plugin passes its workspace-only pending projection. */
    if (!isAgentInstructionsSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      if (!options.includeBaselineScopes && baselineScopes.has(change.scope)) continue
      scopes.add(change.scope)
    }
  }
  for (const scope of effective.keys()) {
    if (!options.includeBaselineScopes && baselineScopes.has(scope)) continue
    const { directory } = decodeScopeKey(scope)
    if (isUserGlobalDirectory(directory)) scopes.add(candidateScopeKey(directory, USER_GLOBAL_FILE))
    else addDirScopes(scopes, directory)
  }
  for (const touchedPath of options.touchedPaths) {
    for (const dir of descendantDirsBetween(cwd, touchedPath)) addProjectScopes(scopes, dir)
  }

  const versions = versionStatesFor(session, versionCache)
  const seenAbsolutePaths = new Set<string>()
  // Per-group trimmed-content identities kept so far this pass, iterated in
  // candidate order (base before local, harness home before shared agents root);
  // a later candidate matching an earlier one is a duplicate and is dropped or
  // removed rather than rendered twice.
  const keptTrimmedByGroup = new Map<string, Set<string>>()
  const hasKeptTrimmed = (group: string, digest: string): boolean => keptTrimmedByGroup.get(group)?.has(digest) ?? false
  const registerKeptTrimmed = (group: string, digest: string): boolean => {
    let digests = keptTrimmedByGroup.get(group)
    if (digests === undefined) {
      digests = new Set()
      keptTrimmedByGroup.set(group, digests)
    }
    if (digests.has(digest)) return true
    digests.add(digest)
    return false
  }
  const items: ChangeRenderItem[] = []
  const versionUpdates: InstructionVersionUpdate[] = []
  const pushRemoval = (scope: string, path: string, state?: InstructionVersionState): void => {
    const change: AgentInstructionChange = { action: 'remove', scope, path }
    items.push({ change, file: { absolutePath: `removed:${scope}`, displayPath: path, content: '' } })
    versionUpdates.push({ change, ...state === undefined ? {} : { state } })
  }
  const scopesByGroup = new Map<string, string[]>()
  for (const scope of scopes) {
    const { directory } = decodeScopeKey(scope)
    const group = instructionCandidateGroup(directory)
    const groupScopes = scopesByGroup.get(group)
    if (groupScopes === undefined) scopesByGroup.set(group, [scope])
    else groupScopes.push(scope)
  }
  for (const [group, groupScopes] of scopesByGroup) {
    const probedScopes: string[] = []
    for (const scope of groupScopes) {
      if (options.excludedBaselineScopes !== undefined
        && baselineScopes.has(scope)
        && options.excludedBaselineScopes.has(scope)) {
        const previous = effective.get(scope)
        if (previous === undefined || previous.action === 'remove') versions.delete(scope)
        else pushRemoval(scope, previous.path)
      } else {
        probedScopes.push(scope)
      }
    }
    const itemStart = items.length
    const versionUpdateStart = versionUpdates.length
    const priorVersions = new Map(probedScopes.map(scope => [scope, versions.get(scope)]))
    // Metadata and content availability apply to the whole deduplicated group,
    // including hidden candidates that may become visible after a sibling edit.
    const rollbackGroup = (): void => {
      items.splice(itemStart)
      versionUpdates.splice(versionUpdateStart)
      for (const [candidateScope, prior] of priorVersions) {
        if (prior === undefined) versions.delete(candidateScope)
        else versions.set(candidateScope, prior)
      }
      // Project aliases must not publish content withheld by a failed group,
      // including candidates whose paths were never reached before the failure.
      for (const scope of probedScopes) {
        seenAbsolutePaths.add(scopeInstructionFile(scope, projectRoot, resolved).absolutePath)
      }
      keptTrimmedByGroup.delete(group)
    }
    for (const scope of probedScopes) {
      const previous = effective.get(scope)
      const probe = await probeScopeInstruction(scope, projectRoot, resolved, fileSystem, options.signal)
      if (probe.kind === 'unavailable') {
        rollbackGroup()
        break
      }
      if (probe.kind === 'absent') {
        if (previous === undefined || previous.action === 'remove') versions.delete(scope)
        else pushRemoval(scope, previous.path)
        continue
      }
      const { file: probedFile } = probe
      if (seenAbsolutePaths.has(probedFile.absolutePath)) continue
      seenAbsolutePaths.add(probedFile.absolutePath)
      const cached = versions.get(scope)
      const metadataUnchanged = cached !== undefined
        && cached.path === probedFile.displayPath
        && cached.version === probedFile.version
      if (metadataUnchanged) {
        const rendered = previous !== undefined
          && previous.action !== 'remove'
          && previous.path === cached.path
          && previous.digest === cached.digest
        if (rendered) {
          // Unchanged and previously rendered: keep it, but an earlier group member
          // that now matches its trimmed content makes this the duplicate to remove.
          if (registerKeptTrimmed(group, cached.trimmedDigest)) pushRemoval(scope, previous.path, cached)
          continue
        }
        // Hidden duplicates include files removed from visible state after
        // becoming duplicates. Only promotion requires another content read.
        if ((previous === undefined || previous.action === 'remove')
          && hasKeptTrimmed(group, cached.trimmedDigest)) continue
      }

      const file = await readScopeInstruction(probedFile, resolved.maxSourceBytes, fileSystem, options.signal)
      if (file === undefined) {
        rollbackGroup()
        break
      }
      const currentDigest = instructionContentSha1(file.content)
      const trimmedDigest = trimmedInstructionDigest(file.content)
      const nextVersion: InstructionVersionState = {
        path: file.displayPath,
        version: probedFile.version,
        digest: currentDigest,
        trimmedDigest,
      }
      if (registerKeptTrimmed(group, trimmedDigest)) {
        // A distinct file whose trimmed content already appeared earlier in this
        // group: drop it, removing any copy that was previously rendered, and keep
        // its metadata so the next pass decides without reading it again.
        if (previous !== undefined && previous.action !== 'remove') {
          pushRemoval(scope, previous.path, nextVersion)
        } else {
          versions.set(scope, nextVersion)
        }
        continue
      }
      if (previous !== undefined && previous.action !== 'remove' && previous.path === file.displayPath && previous.digest === currentDigest) {
        versions.set(scope, nextVersion)
        continue
      }
      const action = previous === undefined || previous.action === 'remove' ? 'set' : 'replace'
      const change: AgentInstructionChange = {
        action,
        scope,
        path: file.displayPath,
        digest: currentDigest,
      }
      items.push({ change, file })
      versionUpdates.push({ change, state: nextVersion })
    }
  }
  if (items.length === 0) return undefined
  const rendered = renderInstructionChanges(items, resolved.maxBytes)
  // When no transition survived rendering (tiny budgets render notice-only
  // text), emit nothing and commit nothing — the uncommitted versions make the
  // next pass retry instead of spamming notice-only contexts.
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined
  return {
    context: agentInstructionsHook(rendered.text, rendered.changes),
    versionUpdates: retainedInstructionVersionUpdates(versionUpdates, rendered.changes),
  }
}
