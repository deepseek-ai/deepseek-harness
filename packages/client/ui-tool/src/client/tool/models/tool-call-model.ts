/**
 * Pure row-model derivation for tool summary rows: variant classification,
 * one-line summary, expansion-time body input, and flattened result output
 * from the frozen call slice. Input material comes from the call ARGUMENTS;
 * output and error material from the settled result node. A supported terminal
 * call gets its expanded body from `terminalCardModel` instead.
 */
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { abbreviateHomePath, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'

export type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

/** Tool-call row variants selected by the generic atomic renderer. */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** Row lifecycle state used by summary styling and accessible status text. */
export type ToolRowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/** Locale-neutral structured fact consumed only by the user-facing Tool row. */
export interface AutoReviewDenial {
  /** Raw persisted reviewer reason; display normalization happens at render time. */
  reason: string | null
}

type ToolTitleKey = Extract<LocaleKeysOf<'conversation'>, `tool.title.${string}` | 'ask.rowTitle' | 'todo.rowTitle'>

/** Locale key per generic row variant. */
export const VARIANT_TITLE_KEYS = {
  search: 'tool.title.search', read: 'tool.title.read', bash: 'tool.title.bash',
  write: 'tool.title.write', edit: 'tool.title.edit', code: 'tool.title.code',
  others: 'tool.title.generic',
} as const satisfies Record<ToolRowVariant, ToolTitleKey>

/**
 * Known tool name -> variant.
 *
 * `cordis_define` is deliberately absent: ui-cordis registers a keyed
 * `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row
 * (this table is only reached through GenericToolCard, the dispatch fallback in
 * ToolCallTree). An entry here would be unreachable, and a second title for the
 * same call would be a second answer to a question the card already owns.
 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  // The PowerShell twin is a shell tool: the bash row family (icon, colors)
  // with its own title from TOOL_TITLE_KEYS, not the generic `others` row.
  pwsh: 'bash',
  read: 'read',
  // read_image is a single-file read: the same browse icon and the same openable
  // path summary (FILE_PATH_VARIANTS covers `read`), with its own title key below.
  // Left unclassified it falls to `others`, which titles the row generically and
  // derives no filePath — so the path the row advertises as openable never is.
  read_image: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  // The three run-control verbs take one package id and produce a receipt, so
  // the generic row is the decided intent, not an unclassified default: there is
  // no program to show (that is `cordis_define`'s card) and no file to open. The
  // id lands in the summary slot, and the titles below name the act.
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** Tool-owned titles that refine a generic row variant without replacing it. */
const TOOL_TITLE_KEYS: Record<string, ToolTitleKey> = {
  cordis_package_inspect: 'tool.title.inspect',
  cordis_runtime_inspect: 'tool.title.inspect',
  cordis_run: 'tool.title.runCordis',
  cordis_stop: 'tool.title.stopCordis',
  cordis_undefine: 'tool.title.removeCordis',
  pwsh: 'tool.title.pwsh',
  read_image: 'tool.title.readImage',
  todo_write: 'todo.rowTitle',
  ask_user_question: 'ask.rowTitle',
  create_goal: 'tool.title.createGoal',
  get_goal: 'tool.title.getGoal',
  update_goal: 'tool.title.updateGoal',
  schedule_create: 'tool.title.createSchedule',
  schedule_list: 'tool.title.listSchedules',
  schedule_delete: 'tool.title.deleteSchedule',
  schedule_update: 'tool.title.updateSchedule',
  cordis_inspect_list: 'tool.title.inspectProviders',
  cordis_inspect_query: 'tool.title.queryRuntime',
  cordis_inspect_self: 'tool.title.inspectPlugins',
  workflow: 'tool.title.workflow',
  ralph: 'tool.title.ralph',
  session_event_read: 'tool.title.readEvent',
  session_event_search: 'tool.title.searchEvents',
  session_event_trace: 'tool.title.traceEvent',
  session_search: 'tool.title.searchSessions',
  session_trace: 'tool.title.traceSession',
  list_subagent_models: 'tool.title.listModels',
  subagent: 'tool.title.subagent',
  list_agents: 'tool.title.listAgents',
  send_message: 'tool.title.sendMessage',
  interrupt_agent: 'tool.title.interruptAgent',
  job_list: 'tool.title.listJobs',
  job_output: 'tool.title.readJob',
  job_kill: 'tool.title.killJob',
  terminal_open: 'tool.title.openTerminal',
  terminal_read: 'tool.title.readTerminal',
  terminal_list: 'tool.title.listTerminals',
  terminal_signal: 'tool.title.signalTerminal',
  terminal_close: 'tool.title.closeTerminal',
  lsp: 'tool.title.lsp',
  spawn_teammate: 'tool.title.spawnTeammate',
  team_task_create: 'tool.title.createTeamTask',
  team_task_get: 'tool.title.getTeamTask',
  team_task_update: 'tool.title.updateTeamTask',
  team_task_list: 'tool.title.listTeamTasks',
  wait_agent: 'tool.title.waitAgent',
}

/**
 * Classify a tool name into its row variant.
 * @param toolName - wire tool name.
 * @returns matching variant, others when unknown.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

/**
 * Select a tool-owned or generic title without reading arguments.
 * @param toolName - wire tool name.
 * @returns the localized title key.
 */
export function toolTitleKey(toolName: string): ToolTitleKey {
  return TOOL_TITLE_KEYS[toolName] ?? VARIANT_TITLE_KEYS[classifyTool(toolName)]
}

/** Everything ToolRow needs, derived once from the frozen slice. */
export interface ToolRowModel {
  variant: ToolRowVariant
  titleKey: ToolTitleKey
  /** Generic rows retain the wire tool name; available arguments append their summary. */
  summary: string
  /**
   * Filesystem path from args (`path` / `file_path`) when the row is a file
   * tool; absent for URL reads and non-file tools. The chat view resolves
   * relative values against the session cwd before opening.
   */
  filePath: string | undefined
  /** Original argument JSON retained for expansion-time body formatting. */
  bodyRaw: string | null
  /** Flattened result text ({@link resultText}); null while running or when the result carries no text. */
  output: string | null
  /** First line of the result text on an error row; null for every other state. */
  errorSummary: string | null
  /** Structured Auto-review denial identity; null for every ordinary result. */
  autoReviewDenial: AutoReviewDenial | null
  state: ToolRowState
}

function deriveAutoReviewDenial(block: ToolCallBlock): AutoReviewDenial | null {
  if (!('kind' in block) || !block.isError) return null
  const error = block.error
  if (error?.name !== 'AutoReviewDeniedError' || error.code !== 'AUTO_REVIEW_DENIED') return null
  // A durable record reaches this renderer without a type check on `reason`, so
  // a non-string value degrades to the no-reason copy exactly as a missing one.
  return { reason: typeof error.reason === 'string' ? error.reason : null }
}

/**
 * Flatten a settled result's content blocks to display text: text blocks
 * verbatim, other block shapes as pretty JSON. Empty content on a failed call
 * falls back to the structured error's `name: code` line.
 * @param node - the settled result node.
 * @returns the flattened result text (may be empty).
 */
export function resultText(node: ToolResultNode): string {
  const parts: string[] = []
  for (const block of node.content) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push(JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) {
    parts.push(`${node.error.name}: ${node.error.code}`)
  }
  return parts.join('\n')
}

function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw)
  } catch {
    // Non-JSON args (mid-stream truncation): summary/body fall back to the raw string.
    return undefined
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** Summary key preference per variant (args-derived; result-derived summaries are a ledger item). */
const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}


function deriveSummary(variant: ToolRowVariant, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query): query is string => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const picked = pickString(args, SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  return firstLine(argsRaw)
}

/** Path keys only — never `url` (web_fetch lands on the read variant). */
const FILE_PATH_KEYS = ['path', 'file_path'] as const

/** File-tool variants whose summary may be an openable workspace path. */
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit'])

function deriveFilePath(variant: ToolRowVariant, argsRaw: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const picked = pickString(parsed as Record<string, unknown>, FILE_PATH_KEYS)
  return picked === undefined ? undefined : firstLine(picked)
}

/**
 * Format one argument payload when its generic input body becomes visible.
 * @param variant - row presentation selected for the Tool name.
 * @param argsRaw - original argument JSON or incomplete raw text.
 * @returns display body, or null for empty input.
 */
export function formatToolBody(variant: ToolRowVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  // The code row's expanded body IS the program (monospace via the row's
  // variant styling), not the args JSON envelope around it.
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
    const code = (parsed as Record<string, unknown>).code
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/**
 * Derive the full row model from a frozen call slice.
 * @param toolName - wire tool name (dispatch-supplied; survives windowless results).
 * @param block - preparing call, dispatched call, or result from the snapshot.
 * @param cwd - session workspace root; workspace-rooted path summaries display relative to it.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 * @returns the row model.
 */
export function toolRowModel(toolName: string, block: ToolCallBlock, cwd?: string, home?: string): ToolRowModel {
  const variant = classifyTool(toolName)
  const titleKey = toolTitleKey(toolName)
  const done = 'kind' in block
  const argsRaw = done ? block.call?.argsRaw ?? '' : block.phase === 'start' ? block.argsRaw : null
  const state: ToolRowState = !done ? block.phase === 'preparing' ? 'preparing' : 'running'
    : block.error?.code === 'interrupted' ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const base = argsRaw === null ? ''
    : argsRaw === '' ? block.callId
      : abbreviateHomePath(relativizeToCwd(deriveSummary(variant, argsRaw), cwd), home)
  const summary = [titleKey === 'tool.title.generic' ? toolName : '', base].filter(Boolean).join(' · ')
  // The empty string is "no text" for both derived result fields: a settled
  // call with blank content has nothing to expand, and a blank first line
  // would erase the collapsed error row's summary slot.
  const output = done ? (resultText(block) || null) : null
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null
  const bodyRaw = argsRaw === '' ? null : argsRaw
  return {
    variant,
    titleKey,
    summary,
    filePath: argsRaw === null ? undefined : deriveFilePath(variant, argsRaw),
    bodyRaw,
    output,
    errorSummary,
    autoReviewDenial: deriveAutoReviewDenial(block),
    state,
  }
}
