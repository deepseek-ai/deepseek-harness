/**
 * The model-facing filesystem discovery tool suite (`glob`, `grep`) over the
 * packaged ripgrep binary (`@vscode/ripgrep`). This single plugin registers
 * both tools; the binary ships inside the npm dependency, so no system `rg`
 * install and no shell layer is involved.
 *
 * ## Spawn-backed, not a `ctx.fs` provider method
 *
 * Local workspace discovery is a process-backed `rg` workflow, so these tools
 * execute through `ctx.subprocess.spawn()` with fixed ripgrep argv templates —
 * never `ctx.shell`, never `ctx.shell.start()`, never a model-visible background
 * task. The tool layer owns schemas, argument validation, argv construction
 * ({@link module:@deepseek-ai/dsh-tool-fs-search/glob} /
 * {@link module:@deepseek-ai/dsh-tool-fs-search/grep}), result parsing,
 * retention, formatted-result spill, and timeout declaration; the subprocess
 * seam owns spawn execution, process-tree termination, environment scrubbing,
 * and raw output capture. The package injects `tools`, `systemPrompt`, and
 * `subprocess` — deliberately NOT `fs`, and `ctx.spillStore` is read
 * opportunistically with `ctx.get()` because formatted-result spill is optional.
 *
 * Returned paths are displayed relative to the resolved workdir and are
 * follow-up-readable only in co-located deployments where the workdir and the
 * filesystem `read` root are the same workspace — a documented v1 deployment
 * requirement, not runtime-validated.
 *
 * @module @deepseek-ai/dsh-tool-fs-search
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { GLOB_MAX_RESULTS, applyGlobTool } from './glob.ts'
import { GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, applyGrepTool } from './grep.ts'
import { RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_META_MAX_BYTES, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS } from './search-core.ts'

export { GLOB_MAX_RESULTS, GLOB_VCS_EXCLUDES, applyGlobTool, buildGlobCommand, formatGlobOutput, parseGlobArgs, presentGlobCall, presentGlobResult, sampleAcrossTopLevel } from './glob.ts'
export type { GlobInput, GlobSample, GlobToolCaps } from './glob.ts'
export {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  applyGrepTool,
  buildGrepCommand,
  formatGrepMatches,
  formatGrepOutput,
  parseGrepArgs,
  parseGrepMatches,
  presentGrepCall,
  presentGrepResult,
} from './grep.ts'
export type { GrepInput, GrepToolCaps } from './grep.ts'
export {
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  previewLine,
  resolveRgPath,
  runRipgrep,
  toWorkdirRelative,
  trySaveFormattedResult,
} from './search-core.ts'
export type { GrepMatch, RipgrepRun, SearchErrorCode } from './search-core.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs-search'

/** Services required by the search tool suite (`spillStore` is optional, read via `ctx.get()`). */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'workingDirectory']

/** Plugin config; over-cap glob sampling is an explicit deployment choice and the remaining fields have defaults. */
export interface Config {
  /** Whether an over-cap `glob` page is sampled across top-level entries instead of taking the modification-time head. */
  sampleOverCapGlobResults: boolean
  /** Max paths one `glob` call retains inline; later paths go to the formatted spill file. */
  globMaxResults?: number
  /** Max flat matches one `grep` call retains inline; later matches go to the formatted spill file. */
  grepMaxMatches?: number
  /** Max bytes retained for one matched-line preview (the cut preserves UTF-8 boundaries). */
  grepMaxLineBytes?: number
  /** Max bytes of one search's serialized `presentationMeta`; trailing groups/paths drop past it so the persisted card stays bounded. */
  searchMetaMaxBytes?: number
  /** Max complete raw `rg` stdout bytes a search will parse; larger raw output fails with `SEARCH_RAW_OUTPUT_OVERFLOW`. */
  rawOutputMaxBytes?: number
  /** Terminate-escalation grace (ms), handed to the subprocess seam and bounded by `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
  /** Max bytes retained for one search's stderr tail; the excerpt is embedded in `SEARCH_*` error messages, never shown on success. */
  stderrMaxBytes?: number
  /**
   * Cooperative tool-call timeout budget (ms) on both tools, enforced by
   * `@deepseek-ai/dsh-tool-call-timeout-policy` through `exec.signal`.
   */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  sampleOverCapGlobResults: z.boolean().required(),
  globMaxResults: z.number().default(GLOB_MAX_RESULTS),
  grepMaxMatches: z.number().default(GREP_MAX_MATCHES),
  grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  searchMetaMaxBytes: z.number().default(SEARCH_META_MAX_BYTES),
  rawOutputMaxBytes: z.number().default(RAW_OUTPUT_MAX_BYTES),
  graceMs: z.number().default(SEARCH_GRACE_MS),
  stderrMaxBytes: z.number().default(SEARCH_STDERR_MAX_BYTES),
  timeoutMs: z.number().default(SEARCH_TIMEOUT_MS),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Every search cap counts items/bytes/milliseconds — a positive integer, or retention and timeout arithmetic misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-fs-search: ${name} must be a positive integer`)
  }
}

/**
 * Register the `glob`/`grep` filesystem discovery tool suite. The packaged
 * ripgrep binary is always available (an npm dependency), so registration is
 * unconditional.
 *
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
// oxlint-disable-next-line typescript/require-await -- async keeps a load-time config rejection a rejection, not a synchronous throw
export async function apply(ctx: Context, config: Config): Promise<void> {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('globMaxResults', resolved.globMaxResults)
  assertPositiveInteger('grepMaxMatches', resolved.grepMaxMatches)
  assertPositiveInteger('grepMaxLineBytes', resolved.grepMaxLineBytes)
  assertPositiveInteger('searchMetaMaxBytes', resolved.searchMetaMaxBytes)
  assertPositiveInteger('rawOutputMaxBytes', resolved.rawOutputMaxBytes)
  assertPositiveInteger('graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-fs-search: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  assertPositiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  applyGlobTool(ctx, {
    sampleOverCapGlobResults: resolved.sampleOverCapGlobResults,
    maxResults: resolved.globMaxResults,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
  applyGrepTool(ctx, {
    maxMatches: resolved.grepMaxMatches,
    maxLineBytes: resolved.grepMaxLineBytes,
    maxMetaBytes: resolved.searchMetaMaxBytes,
    rawOutputMaxBytes: resolved.rawOutputMaxBytes,
    graceMs: resolved.graceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    timeoutMs: resolved.timeoutMs,
  })
}
