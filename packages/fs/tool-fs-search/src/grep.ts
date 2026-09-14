/**
 * The model-facing `grep` tool: search file contents with a ripgrep regular
 * expression. Execution spawns the packaged ripgrep binary
 * (`@vscode/ripgrep`) directly through the subprocess seam with a plain argv
 * vector using a fixed line-oriented `rg --json` command so file path, line
 * number, and line text parse without colon-splitting ambiguity — this module
 * owns the model-facing schema, argument validation, argv construction,
 * `--json` record parsing, per-line preview retention, match retention,
 * grouping, and formatting; process concerns stay behind `ctx.subprocess`.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/grep
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { GrepMatch } from './search-core.ts'
import { SearchError, previewLine, retainGrepMatches, runRipgrep, toWorkdirRelative, trySaveFormattedResult } from './search-core.ts'
import { grepSearchMeta, searchViewFromMeta } from './presentation.ts'
import { acceptedDirectCallValue } from './direct-call.ts'

/**
 * Default cap on flat matches retained inline by one `grep` call (the
 * `grepMaxMatches` config), matching Claude Code's default `GrepTool`
 * `head_limit`.
 */
export const GREP_MAX_MATCHES = 250

/**
 * Default cap in bytes on one matched-line preview (the `grepMaxLineBytes`
 * config); the cut preserves UTF-8 boundaries.
 */
export const GREP_MAX_LINE_BYTES = 2000

/** Resolved grep-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface GrepToolCaps {
  /** Max flat matches retained inline; later matches go to the formatted spill file. */
  maxMatches: number
  /** Max bytes retained per matched-line preview. */
  maxLineBytes: number
  /** Max bytes of serialized `presentationMeta`; trailing file groups drop past it. */
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

/** Validated `grep` arguments. */
export interface GrepInput {
  pattern: string
  path?: string
  include?: string
}

/**
 * Reject an `include` that is not ONE positive glob filter: blank strings,
 * negated patterns (`!…`), and comma-separated lists. A comma inside a brace
 * group is fine — `*.{ts,tsx}` is one glob with alternation, not a list.
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/**
 * Validate value constraints the schema DSL can't express: a non-EMPTY
 * `pattern` (whitespace is a legitimate regex), a non-blank `path` when given,
 * and a single positive `include` glob ({@link GrepInput}). Throws a plain
 * `Error` (an ordinary tool argument error) otherwise.
 *
 * @param args - the schema-validated `grep` arguments.
 * @returns the accepted input, unchanged.
 */
export function parseGrepArgs(args: { pattern: string; path?: string; include?: string }): GrepInput {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.include !== undefined) validateInclude(args.include)
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
  }
}

/**
 * Build the fixed line-oriented `rg --json` argv for one `grep` call. Every
 * model-controlled value ({@link GrepInput.pattern}, {@link GrepInput.path},
 * {@link GrepInput.include}) is a plain argv element — no shell layer exists,
 * so no quoting applies; the pattern and include ride in `--flag=value` form
 * and the target behind `--`, so a leading-dash value can never be parsed as
 * a flag.
 *
 * @param input - the validated arguments.
 * @returns the complete ripgrep argument vector (excluding the binary itself).
 */
export function buildGrepCommand(input: GrepInput): string[] {
  const parts = ['--json', `--regexp=${input.pattern}`]
  if (input.include !== undefined) parts.push(`--glob=${input.include}`)
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * The uniform malformed-output failure: raw `rg --json` is an internal
 * transport, so missing or invalid response fields cause a search failure, not a partial result.
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(`grep received malformed ripgrep --json output (${detail})`, 'SEARCH_FAILED', cause !== undefined ? { cause } : undefined)
}

/**
 * Parse one `rg --json` NDJSON line into a match, `undefined` for the
 * non-match record types (`begin`/`end`/`context`/`summary`). A line that is
 * not JSON, or a `match` record missing its path / line number / line content,
 * throws {@link SearchError} `SEARCH_FAILED`. A match whose line is not valid
 * UTF-8 (ripgrep sends base64 `bytes` instead of `text`) yields a placeholder
 * preview rather than failing the whole search.
 */
function parseRecord(line: string): GrepMatch | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw malformedRecord('a line is not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw malformedRecord('a record is not an object')
  const record = parsed as { type?: unknown; data?: unknown }
  // Non-match record types (begin/end/context/summary — and any future type)
  // are transport framing, not results: skipped, not malformed.
  if (record.type !== 'match') return undefined
  if (typeof record.data !== 'object' || record.data === null) throw malformedRecord('a match record has no data')
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown }
  const pathText = typeof data.path === 'object' && data.path !== null ? (data.path as { text?: unknown }).text : undefined
  if (typeof pathText !== 'string') throw malformedRecord('a match record has no path text')
  if (typeof data.line_number !== 'number') throw malformedRecord('a match record has no line number')
  if (typeof data.lines !== 'object' || data.lines === null) throw malformedRecord('a match record has no line content')
  const lines = data.lines as { text?: unknown; bytes?: unknown }
  if (typeof lines.text === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: lines.text.replace(/\r?\n$/, '') }
  }
  if (typeof lines.bytes === 'string') {
    return { path: pathText, lineNumber: data.line_number, line: '(line is not valid UTF-8)' }
  }
  throw malformedRecord('a match record has neither line text nor bytes')
}

/**
 * Parse complete `rg --json` stdout into flat matches, in output order (ripgrep
 * emits one file's matches contiguously). Only `match` records are consumed.
 *
 * @param stdout - the complete raw `rg --json` stdout.
 * @returns the flat matches; empty for output with no match records.
 */
export function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const match = parseRecord(line)
    if (match !== undefined) matches.push(match)
  }
  return matches
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body:
 * each file's display path, then one `Line N: <text>` row per match.
 *
 * @param matches - the flat matches to render.
 * @returns the grouped body text.
 */
export function formatGrepMatches(matches: GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Format the model-facing `grep` result: a found-count header, the retained
 * matches grouped by file, then — when the result was capped — a footer
 * carrying either the formatted-spill recovery locator or the could-not-save
 * explanation. The omitted count is a budget fact: the search itself completed.
 *
 * @param retained - the retention outcome over every parsed match.
 * @param spillRef - the saved complete-result reference, or `undefined` when unsaved.
 * @returns the model-facing text.
 */
export function formatGrepOutput(retained: RetainedItems<GrepMatch>, spillRef: SpillRef | undefined): string {
  const header = retained.truncated
    ? `Found ${retained.kept} of ${retained.seen} matches`
    : `Found ${retained.seen} ${matchNoun(retained.seen)}`
  const body = formatGrepMatches(retained.items)
  if (!retained.truncated) return `${header}\n\n${body}`
  const recovery = spillRef !== undefined
    ? `Full grep result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern, path, or include to see more.'
  return `${header}\n\n${body}\n\n(${recovery})`
}

/** Format one already-retained match list for the Native surface. */
function formatRetainedGrep(retained: RetainedItems<GrepMatch>, spillRef?: SpillRef): string {
  if (retained.seen === 0) return 'No matches found'
  return formatGrepOutput(retained, spillRef)
}

/**
 * Pending-call presentation: a search card titled by the pattern (and target /
 * include filter).
 *
 * @param args - the raw tool arguments; `pattern`, `path`, and `include` feed the title.
 * @returns the generic card view (`kind: 'search'`) shown while the call runs.
 */
export function presentGrepCall(args: { pattern: string; path?: string; include?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined ? ` (${args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}

/**
 * Completed-call presentation: the search card projected from the result's
 * `presentationMeta` (matches grouped by file, with the truncation signal). A UI
 * without a search card falls back to the raw `tool/result` content, so the view
 * carries no result text of its own. Malformed or absent metadata (an obsolete or
 * hand-edited replayed log) falls back to the generic card.
 *
 * @param _args - the raw tool arguments; unused, the view derives from the result.
 * @param result - the final model-facing tool result carrying the projected metadata.
 * @returns the search card view, or `undefined` for the generic fallback.
 */
export function presentGrepResult(
  _args: { pattern: string; path?: string; include?: string },
  result: ToolResult,
): SearchResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  if (view === undefined || view.shape !== 'matches') return undefined
  return view
}

/**
 * Register the `grep` tool and its scope-aware system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param caps - the deployment's resolved grep caps (plugin config after defaulting).
 */
export function applyGrepTool(ctx: Context, caps: GrepToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === undefined
      ? ''
      : 'Use the grep tool — not shell grep or rg — to search file contents.'
        + (ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'),
  })

  const tool = defineTool({
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. '
      + `Returns the first ${caps.maxMatches} matches inline; a capped result reports where the complete match list was saved. `
      + 'Use read on a matched file for surrounding context.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatRetainedGrep(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes)),
      }],
      presentationMeta: (_args, value) =>
        grepSearchMeta(retainGrepMatches(value.matches, caps.maxMatches, caps.maxLineBytes), caps.maxMetaBytes),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      const run = await runRipgrep(ctx, exec, 'grep', buildGrepCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      if (run.noMatches) return { matches: [] }

      const all: GrepMatch[] = []
      for (const raw of parseGrepMatches(run.stdout)) {
        const match: GrepMatch = {
          path: toWorkdirRelative(raw.path, run.workdir),
          lineNumber: raw.lineNumber,
          line: raw.line,
        }
        all.push(match)
      }
      return { matches: all }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  })
  ctx.tools.register(tool)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const value = acceptedDirectCallValue(ctx, tool, exec, result, decision) as { matches: GrepMatch[] } | undefined
    if (value === undefined) return decision
    const matches = value.matches
    if (matches.length <= caps.maxMatches) return decision
    // The spill artifact holds the COMPLETE result: preview each line, but keep
    // every match (no inline cap), so the recovery file is the full search.
    const previewedAll = matches.map(match => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }))
    const spillRef = await trySaveFormattedResult(
      ctx,
      exec,
      'grep-results.txt',
      `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(previewedAll)}`,
    )
    return {
      kind: 'accept',
      content: [{
        type: 'text',
        text: formatRetainedGrep(retainGrepMatches(matches, caps.maxMatches, caps.maxLineBytes), spillRef),
      }],
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  })
}
