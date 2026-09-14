/**
 * The model-facing `glob` tool: discover files whose paths match a glob
 * pattern, sorted by modification time. Execution spawns the packaged
 * ripgrep binary (`@vscode/ripgrep`) directly through the subprocess seam
 * with a plain argv vector — this module owns the model-facing schema,
 * argument validation, argv construction, result parsing, inline sampling,
 * and formatting; process concerns (spawn execution, tree termination,
 * environment scrubbing, output capture) stay behind `ctx.subprocess`.
 * @module @deepseek-ai/dsh-tool-fs-search/glob
 */

import type { Context } from '@deepseek-ai/cordis'
import { sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import { runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { globSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * Default cap on paths retained inline by one `glob` call (the `globMaxResults`
 * config), matching Claude Code's default `GlobTool` result limit.
 */
export const GLOB_MAX_RESULTS = 100

/**
 * Directory names ripgrep must never descend into for a discovery listing: VCS
 * metadata stores. `--no-ignore --hidden` would otherwise surface them in every
 * broad search. Each name is excluded with TWO negated `--glob`s (see
 * {@link buildGlobCommand}): an any-depth directory glob that matches — and
 * prunes — the directory during traversal, and a contents glob that still
 * excludes the internals when the search root itself is at or inside the
 * directory (an explicit `path` of `.git` or `sub/.git`), where the prune glob
 * alone never matches.
 */
export const GLOB_VCS_EXCLUDES: readonly string[] = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/** Resolved glob-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GlobToolCaps {
  /** Whether over-cap pages are sampled across top-level entries instead of taking the modification-time head. */
  sampleOverCapGlobResults: boolean
  /** Max paths retained inline; later paths go to the formatted spill file. */
  maxResults: number
  /** Max bytes of serialized `presentationMeta`; trailing paths drop past it. */
  maxMetaBytes: number
  /** Cap on the complete raw `rg` stdout the tool will parse. */
  rawOutputMaxBytes: number
  /** Terminate-escalation grace period (ms) for the search process. */
  graceMs: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Cooperative tool-call budget (ms) attached as `ToolDefinition.timeoutMs`. */
  timeoutMs: number
}

/** Validated `glob` arguments. */
export interface GlobInput {
  pattern: string
  path?: string
}

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `pattern`, and a non-blank `path` when given. Throws a plain `Error` (an
 * ordinary tool argument error) otherwise.
 *
 * @param args - the schema-validated `glob` arguments.
 * @returns the accepted input, unchanged.
 */
export function parseGlobArgs(args: { pattern: string; path?: string }): GlobInput {
  if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  return { pattern: args.pattern, ...args.path !== undefined ? { path: args.path } : {} }
}

/**
 * Build the fixed `rg --files` argv for one `glob` call. Every
 * model-controlled value ({@link GlobInput.pattern}, {@link GlobInput.path})
 * is a plain argv element — no shell layer exists, so no quoting applies; the
 * search root rides behind `--` so a leading-dash path can never be parsed as
 * a flag. `--sort=modified` orders by modification time, `--no-ignore
 * --hidden` searches ignored and hidden files, and
 * {@link GLOB_VCS_EXCLUDES} keeps VCS metadata out.
 *
 * @param input - the validated arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildGlobCommand(input: GlobInput): string[] {
  const parts = [
    '--files',
    `--glob=${input.pattern}`,
    '--sort=modified',
    '--no-ignore',
    '--hidden',
    // Two negated globs per VCS name: the bare form prunes the directory
    // during traversal; the /** form still excludes the contents when the
    // search root is AT or INSIDE the directory (where the bare form,
    // matched against root-prefixed paths, never fires).
    ...GLOB_VCS_EXCLUDES.flatMap(name => [
      `--glob=!**/${name}`,
      `--glob=!**/${name}/**`,
    ]),
  ]
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * The inline page of a capped `glob` result, plus how much of the complete
 * result's top level it reaches.
 */
export interface GlobSample {
  /** Paths to show inline: grouped by top-level entry, modification-time ordered within each group. */
  items: string[]
  /** Distinct top-level entries the shown paths reach. */
  shown: number
  /** Distinct top-level entries across the complete result. */
  total: number
}

/** Remove the displayed search-root prefix before choosing a top-level group. */
function relativeToSearchRoot(path: string, root: string): string {
  if (root === '.') return path.startsWith(`.${sep}`) ? path.slice(2) : path
  let rootEnd = root.length
  while (rootEnd > 0 && root[rootEnd - 1] === sep) rootEnd -= 1
  const trimmedRoot = root.slice(0, rootEnd)
  if (trimmedRoot.length === 0) return stripLeadingSeparators(path)
  if (path === trimmedRoot) return ''
  if (path.startsWith(`${trimmedRoot}${sep}`)) {
    return path.slice(trimmedRoot.length + 1)
  }
  return path
}

/** Strip only separators recognized by the execution platform. */
function stripLeadingSeparators(path: string): string {
  let start = 0
  while (path[start] === sep) start += 1
  return path.slice(start)
}

/**
 * The leading path segment of one display path — the top-level entry, relative
 * to the search root, that the path sits under. A path with no separator is its
 * own top-level entry. Leading separators are stripped first so an absolute path
 * (one outside the workdir, which {@link toWorkdirRelative} leaves untouched)
 * groups by its first real name instead of collapsing every such path into one
 * empty group.
 */
function topLevelSegment(path: string): string {
  const trimmed = stripLeadingSeparators(path)
  const cut = trimmed.indexOf(sep)
  return cut === -1 ? trimmed : trimmed.slice(0, cut)
}

/**
 * Choose the inline page of an over-cap result by round-robin across the
 * complete result's top-level entries, instead of taking its head.
 *
 * Every top-level entry receives a slot before any receives a second; exhausted
 * groups drop out. Group order and order within each group follow `paths`, so a
 * flat result reproduces the modification-time head.
 *
 * @param paths - the complete result, in ripgrep's modification-time order.
 * @param maxItems - how many paths the page may hold; the caller has already established it is smaller than `paths`.
 * @param root - the search root in the same display-path space as `paths`.
 * @returns the page grouped by top-level entry, with the shown/total top-level spread.
 */
export function sampleAcrossTopLevel(paths: readonly string[], maxItems: number, root = '.'): GlobSample {
  type ActiveGroup = { key: string; items: string[]; index: number; current: string }
  const groups = new Map<string, string[]>()
  let active: ActiveGroup[] = []
  for (const path of paths) {
    const key = topLevelSegment(relativeToSearchRoot(path, root))
    const group = groups.get(key)
    if (group === undefined) {
      const items = [path]
      groups.set(key, items)
      active.push({ key, items, index: 0, current: path })
    } else {
      group.push(path)
    }
  }
  const taken = new Map<string, string[]>()
  let count = 0
  while (active.length > 0 && count < maxItems) {
    const nextActive: ActiveGroup[] = []
    for (const { key, items, index, current } of active) {
      if (count >= maxItems) break
      count += 1
      const bucket = taken.get(key)
      if (bucket === undefined) taken.set(key, [current])
      else bucket.push(current)
      const nextIndex = index + 1
      const nextPath = items[nextIndex]
      if (nextPath !== undefined) nextActive.push({ key, items, index: nextIndex, current: nextPath })
    }
    active = nextActive
  }
  return { items: [...taken.values()].flat(), shown: taken.size, total: groups.size }
}

/**
 * Format a capped sampled page and its complete-result recovery path. A flat
 * result keeps the plain footer because its sample is the modification-time head.
 *
 * @param sample - the inline page and its top-level spread.
 * @param seen - how many paths the complete result holds; always more than the page.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @returns the model-facing text.
 */
export function formatGlobOutput(sample: GlobSample, seen: number, spillRef: SpillRef | undefined): string {
  const basis = sample.total === seen
    ? '.'
    : `, sampled across ${sample.shown} of the ${sample.total} top-level entries this pattern matched instead of taken in modification-time order.`
      + (sample.shown < sample.total ? ' Narrow path to inspect a specific subtree.' : '')
  return formatGlobPage(sample.items, seen, spillRef, basis)
}

/** Format one bounded page and the recovery path for its complete sorted result. */
function formatGlobPage(items: readonly string[], seen: number, spillRef: SpillRef | undefined, basis: string): string {
  const body = items.join('\n')
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${body}\n\n(Showing ${items.length} of ${seen} paths${basis} ${recovery})`
}

/** Bound and format one canonical path list for the Native surface relative to its search root. */
function renderGlobPaths(paths: string[], caps: GlobToolCaps, root: string, spillRef?: SpillRef): string {
  if (paths.length === 0) return 'No files found'
  // A result that fits is shown whole, untouched: modification-time order is the
  // tool's contract, and over a complete result it is what answers age questions.
  if (paths.length <= caps.maxResults) return paths.join('\n')
  if (!caps.sampleOverCapGlobResults) {
    return formatGlobPage(paths.slice(0, caps.maxResults), paths.length, spillRef, '.')
  }
  return formatGlobOutput(sampleAcrossTopLevel(paths, caps.maxResults, root), paths.length, spillRef)
}

/**
 * The inline page of paths a completed `glob` card shows, computed the SAME way
 * {@link renderGlobPaths} computes its model-facing page so the card and the text
 * agree on which paths survived the cap. A result within the cap is shown whole;
 * an over-cap result is either the modification-time head or the top-level sample,
 * matching the deployment's `sampleOverCapGlobResults`.
 *
 * @param paths - the complete discovered path list, in modification-time order.
 * @param caps - the resolved glob caps (the inline cap and the sampling switch).
 * @param root - the search root in the same display-path space as `paths`.
 * @returns the inline page and whether the complete result was capped.
 */
function globCardPage(paths: string[], caps: GlobToolCaps, root: string): { items: string[]; truncated: boolean } {
  if (paths.length <= caps.maxResults) return { items: paths, truncated: false }
  if (!caps.sampleOverCapGlobResults) return { items: paths.slice(0, caps.maxResults), truncated: true }
  return { items: sampleAcrossTopLevel(paths, caps.maxResults, root).items, truncated: true }
}

/**
 * Pending-call presentation: a search card titled by the pattern (and root).
 *
 * @param args - the raw tool arguments; `pattern` and `path` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGlobCall(args: { pattern: string; path?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  return { card: 'generic', title: `Glob ${args.pattern}${where}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (the discovered path list, with the truncation signal). A UI
 * without a search card falls back to the raw `tool/result` content, so the view
 * carries no result text of its own. Malformed or absent metadata (an obsolete or
 * hand-edited replayed log) falls back to the generic card.
 *
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the projected metadata.
 * @returns the search card view, or `undefined` for the generic fallback.
 */
export function presentGlobResult(_args: { pattern: string; path?: string }, result: ToolResult): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'paths') return undefined
  return view
}

/**
 * Register the `glob` tool and its scope-aware system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param caps - the deployment's resolved glob caps (plugin config after defaulting).
 */
export function applyGlobTool(ctx: Context, caps: GlobToolCaps): void {
  const overCapGuidance = caps.sampleOverCapGlobResults
    ? 'while a larger one is sampled across top-level entries, so it spans the tree instead of one subtree.'
    : 'while a larger one keeps the modification-time-ordered head.'
  ctx.systemPrompt.section({
    name: 'tool:glob',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GLOB'),
    text: ({ scope }) => ctx.tools.get('glob', scope) === undefined
      ? ''
      : 'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. '
      + `Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, ${overCapGuidance}`,
  })

  const overCapDescription = caps.sampleOverCapGlobResults
    ? `a larger result instead returns ${caps.maxResults} paths sampled across top-level entries`
    : `a larger result returns the first ${caps.maxResults} paths in modification-time order`
  const tool = defineTool({
    name: 'glob',
    description: 'Find files whose paths match a glob pattern. Returns matching file paths — never directories — '
      + 'including hidden and ignored files (VCS metadata directories are excluded). '
      + `Up to ${caps.maxResults} paths come back in modification-time order; ${overCapDescription}, `
      + 'says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). '
          + 'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
      },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGlobPaths(value.paths, caps, value.root) }],
      presentationMeta: (_args, value) => {
        const page = globCardPage(value.paths, caps, value.root)
        return globSearchMeta({ items: page.items, truncated: page.truncated, seen: value.paths.length }, caps.maxMetaBytes)
      },
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      const run = await runRipgrep(ctx, exec, 'glob', buildGlobCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      const root = input.path === undefined ? '.' : toWorkdirRelative(input.path, run.workdir)
      if (run.noMatches) return { root, paths: [] }

      const all: string[] = []
      for (const line of run.stdout.split('\n')) {
        if (line.length === 0) continue
        const displayPath = toWorkdirRelative(line, run.workdir)
        all.push(displayPath)
      }
      return { root, paths: all }
    },
    presentCall: presentGlobCall,
    presentResult: presentGlobResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { root: string; paths: string[] } | undefined
    if (value === undefined) return decision
    const paths = value.paths
    if (paths.length <= caps.maxResults) return decision
    const spillRef = await trySaveFormattedResult(ctx, exec, 'glob-results.txt', paths.join('\n'))
    return {
      kind: 'accept',
      content: [{ type: 'text', text: renderGlobPaths(paths, caps, value.root, spillRef) }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
