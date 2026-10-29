/**
 * The tool surface a shared Session and its fork children may use.
 *
 * The source-session sandbox and each fork child's limit read this one table, so both admit the same
 * tools at the same tiers. Each entry states how that tool's own arguments name workspace paths and how
 * a checked call is handed back with canonical paths; a tool the table does not name is refused.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/shared-tools
 */

import { isRecord } from './wire-json.ts'

/** Tier that admits one shared tool. */
export type SharedToolTier = 'view' | 'write'

/** Paths one tool call names, as an enforcement guard reads them. */
export interface SharedToolPaths {
  /**
   * Every path the call names, empty when it names none, or undefined when they cannot be established.
   *
   * Empty means the tool's own default is the granted workspace, never "no filesystem effect": an entry
   * states that separately.
   */
  readonly paths: readonly string[] | undefined
  /** Whether the tool declares that it touches no workspace file at all. */
  readonly noFileEffect: boolean
}

/** One tool call's declared paths and the rewrite that hands the tool their canonical form. */
export interface SharedToolCall {
  /** Paths this call names, in the order {@link SharedToolCall.rewrite} consumes them. */
  readonly paths: readonly string[]
  /**
   * Rewrite the call's arguments so it opens exactly the canonical targets this host checked.
   * @param canonical - Canonical path for each entry of {@link SharedToolCall.paths}, in the same order.
   * @returns The arguments to delegate with.
   */
  rewrite(canonical: readonly string[]): Record<string, unknown>
}

/** One confined edit call's validated arguments. */
export interface SharedEditArguments {
  /** Path the call names, non-empty. */
  readonly filePath: string
  /** Literal text to replace, non-empty. */
  readonly oldString: string
  /** Literal replacement text, which must differ from {@link SharedEditArguments.oldString}. */
  readonly newString: string
  /** Whether every match is replaced instead of requiring exactly one. */
  readonly replaceAll: boolean
}

/**
 * Read and validate one edit call's arguments.
 *
 * A bounded edit body replaces the deployment tool's execution, so it runs that tool's own argument
 * checks itself: the file must be named, and the replaced text must be non-empty and actually change.
 * @param args - Call arguments exactly as the runtime presents them.
 * @returns The validated arguments, or undefined when the call names no usable edit.
 */
export function sharedEditArguments(args: unknown): SharedEditArguments | undefined {
  const input = isRecord(args) ? args : {}
  const filePath = input.file_path
  const oldString = input.old_string
  const newString = input.new_string
  if (typeof filePath !== 'string' || filePath === ''
    || typeof oldString !== 'string' || oldString === ''
    || typeof newString !== 'string' || oldString === newString) {
    return undefined
  }
  return { filePath, oldString, newString, replaceAll: input.replace_all === true }
}

/** One tool the shared surface admits, and how this host reads and bounds it. */
export interface SharedToolProfile {
  /** Tool name the deployment registers. */
  readonly name: string
  /** Lowest tier that admits the tool. */
  readonly tier: SharedToolTier
  /** Whether the tool touches no workspace file, so a call needs no path check. */
  readonly noFileEffect: boolean
  /**
   * Whether a call may omit its path, in which case it searches the granted workspace.
   *
   * Such a call names no path itself, so its replacement supplies the Session's working directory.
   */
  readonly defaultsToWorkspace: boolean
  /**
   * Read one call's paths and the rewrite that consumes their canonical form.
   * @param args - Parsed call arguments.
   * @returns The call, or undefined when the arguments name no path this host can establish.
   */
  call(args: Record<string, unknown>): SharedToolCall | undefined
}

/**
 * Read a call whose only path argument is `file_path`.
 * @param args - Parsed call arguments.
 * @returns The call naming that file, or undefined when it names none.
 */
function filePathCall(args: Record<string, unknown>): SharedToolCall | undefined {
  const path = args.file_path
  if (typeof path !== 'string' || path === '') return undefined
  return { paths: [path], rewrite: canonical => ({ ...args, file_path: canonical[0] }) }
}

/**
 * Read a search call whose optional `path` argument selects its root.
 * @param args - Parsed call arguments.
 * @returns The call, with no declared path when it searches the workspace default.
 */
function searchPathCall(args: Record<string, unknown>): SharedToolCall | undefined {
  const path = args.path
  if (path === undefined) return { paths: [], rewrite: canonical => ({ ...args, path: canonical[0] }) }
  if (typeof path !== 'string' || path === '') return undefined
  return { paths: [path], rewrite: canonical => ({ ...args, path: canonical[0] }) }
}

/**
 * Read a delivery call whose `files` entries each name a path.
 * @param args - Parsed call arguments.
 * @returns The call naming every presented file, or undefined when any entry names none.
 */
function presentedFilesCall(args: Record<string, unknown>): SharedToolCall | undefined {
  const files = args.files
  if (!Array.isArray(files)) return undefined
  const entries: Record<string, unknown>[] = []
  const paths: string[] = []
  for (const file of files) {
    if (!isRecord(file)) return undefined
    const path = file.path
    if (typeof path !== 'string' || path === '') return undefined
    entries.push(file)
    paths.push(path)
  }
  return {
    paths,
    rewrite: canonical => ({
      ...args,
      files: entries.map((file, index) => ({ ...file, path: canonical[index] })),
    }),
  }
}

/**
 * Read a call the tool declares has no filesystem effect.
 * @param args - Parsed call arguments.
 * @returns The call, unchanged and naming no path.
 */
function noFileCall(args: Record<string, unknown>): SharedToolCall {
  return { paths: [], rewrite: () => args }
}

/** Every tool the shared surface admits, in the order replacements are installed. */
export const SHARED_TOOL_PROFILES: readonly SharedToolProfile[] = [
  { name: 'read', tier: 'view', noFileEffect: false, defaultsToWorkspace: false, call: filePathCall },
  { name: 'read_image', tier: 'view', noFileEffect: false, defaultsToWorkspace: false, call: filePathCall },
  { name: 'glob', tier: 'view', noFileEffect: false, defaultsToWorkspace: true, call: searchPathCall },
  { name: 'grep', tier: 'view', noFileEffect: false, defaultsToWorkspace: true, call: searchPathCall },
  { name: 'present', tier: 'view', noFileEffect: false, defaultsToWorkspace: false, call: presentedFilesCall },
  { name: 'todo_write', tier: 'view', noFileEffect: true, defaultsToWorkspace: false, call: noFileCall },
  { name: 'skill', tier: 'view', noFileEffect: true, defaultsToWorkspace: false, call: noFileCall },
  { name: 'web_search', tier: 'view', noFileEffect: true, defaultsToWorkspace: false, call: noFileCall },
  { name: 'web_fetch', tier: 'view', noFileEffect: true, defaultsToWorkspace: false, call: noFileCall },
  { name: 'edit', tier: 'write', noFileEffect: false, defaultsToWorkspace: false, call: filePathCall },
  { name: 'write', tier: 'write', noFileEffect: false, defaultsToWorkspace: false, call: filePathCall },
]

/**
 * Look up one tool on the shared surface.
 * @param name - Tool name.
 * @returns Its profile, or undefined when the surface does not admit that name.
 */
export function sharedToolProfile(name: string): SharedToolProfile | undefined {
  return SHARED_TOOL_PROFILES.find(profile => profile.name === name)
}

/**
 * List the names the shared surface admits at one tier.
 * @param tier - Highest tier whose tools to list; `write` includes the `view` tools.
 * @returns Every admitted tool name, in table order.
 */
export function sharedToolNames(tier: SharedToolTier): readonly string[] {
  return SHARED_TOOL_PROFILES.filter(profile => profile.tier === 'view' || tier === 'write')
    .map(profile => profile.name)
}

/**
 * Describe one call for an enforcement guard.
 * @param name - Tool name.
 * @param args - Call arguments exactly as the runtime presents them.
 * @returns The paths the call names and whether the tool has no file effect; a name the surface does
 *   not admit, or arguments it cannot read, establish no path.
 */
export function describeSharedTool(name: string, args: unknown): SharedToolPaths {
  const profile = sharedToolProfile(name)
  if (profile === undefined) return { paths: undefined, noFileEffect: false }
  if (profile.noFileEffect) return { paths: [], noFileEffect: true }
  const call = isRecord(args) ? profile.call(args) : undefined
  return call === undefined
    ? { paths: undefined, noFileEffect: false }
    : { paths: call.paths, noFileEffect: false }
}

/**
 * Supply the granted workspace as the search root of a call that omitted its path.
 *
 * A call that names no path still reads files, so a guard that checks only named paths would refuse it
 * for having nothing to check. The default is the Session's working directory, which the replacement
 * resolves against the granted root like any other path.
 * @param described - Paths an argument reader established.
 * @param name - Tool name.
 * @param workspace - Directory the tool searches when the call names none.
 * @returns The described paths, with the workspace substituted for a pathless default-root call.
 */
export function withDefaultSearchRoot(
  described: SharedToolPaths,
  name: string,
  workspace: string,
): SharedToolPaths {
  const profile = sharedToolProfile(name)
  if (profile?.defaultsToWorkspace !== true || described.paths === undefined || described.paths.length > 0) {
    return described
  }
  return { paths: [workspace], noFileEffect: false }
}
