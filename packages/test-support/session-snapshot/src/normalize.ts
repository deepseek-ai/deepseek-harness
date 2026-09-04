/**
 * Pure ACP transcript and session-log normalizers. They scrub session ids, run cwd, RPC ids,
 * timestamps, goal lifecycle clocks, and hook duration while preserving semantic payload values.
 * Request-header scrubbers stay composable so one scenario per header class can pin prompt and
 * tool-schema sidecars.
 * @module @deepseek-ai/dsh-session-snapshot/normalize
 */

import {
  decodeSeqRanges,
} from '@deepseek-ai/dsh-session'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { redactSessionSnapshotIds } from './identity.ts'

const SESSION_ID = '{{sessionId}}'
const MESSAGE_ID = '{{messageId}}'
const USED_TOKENS = '{{usedTokens}}'
const CWD = '{{cwd}}'
const SYSTEM = '{{system}}'
const TOOLS = '{{tools}}'
const EVENT_TIME = '{{eventTime}}'
const EVENT_OMITTED_BYTES = '{{eventOmittedBytes}}'
const PACKED_CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

function isPackedFixtureRow(record: Record<string, unknown>): boolean {
  return typeof record.type === 'string' && PACKED_CHUNK_ROW_TYPES.has(record.type)
}

function omitFixtureEnvelope(record: Record<string, unknown>): void {
  delete record.seq
  delete record.time
  delete record.seq0
  delete record.time0
}

/** A cwd-rooted path after volatile cwd replacement, through its last separator-delimited segment. */
const CWD_ROOTED_PATH_RE = /\{\{cwd\}\}(?:[\\/][^\s<>"'`]+)+/g
const PATH_TAG_RE = /(<path>)([^<]*)(<\/path>)/g
const ADDITIONAL_INSTRUCTIONS_PATH_RE = /(Additional instructions from: )([^\r\n]+)/g
const EMBEDDED_EVENT_TIME_RE = /^(  "time": )\d+(?=,\r?$)/gm
const EVENT_READ_OMITTED_BYTES_RE = /(\r?\n\r?\n\(Omitted )\d+( bytes\.)/g
const EVENT_READ_TARGET_REGION_RE
  = /^Session [^\r\n]+ — [^\r\n]+\r?\nTarget event seq \d+:\r?\n```json\r?\n\{\r?\n[\s\S]*?(?=\r?\n```(?:\r?\n|$)|\r?\n\r?\n\(Omitted )/
const PATH_TEXT_BOUNDARY_RE = /[\s<>'"`()\[\]{},;:!?=]/
const FILE_URI_PATH_PREFIX_RE = /(?:^|[^a-z0-9+.-])file:\/\/\/?$/i

/** A UUID v4 string, the shape `randomUUID()` produces for session ids. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const LOCAL_SPILL_PATH_RE = new RegExp(
  String.raw`\{\{cwd\}\}[\\/]\.spill[\\/]session-[0-9a-f]{12}[\\/][0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)]|$)`,
  'g',
)
const SNAPSHOT_SPILL_PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:)?[\\/](?:tmp|t)[\\/](?:dsh-acp-snap-[0-9a-f]{9}|dsh-acp-snapshot-spill)[\\/]session-[0-9a-f]{12}[\\/][0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)]|$)`,
  'g',
)

/**
 * Extract every snapshot-mode spill path from a session log, keyed by spill
 * filename. Used by refresh write-back to keep spill paths stable across runs.
 * @param content - the raw session log text to scan.
 * @returns spill filename → the full matched spill path, last match wins per name.
 */
export function extractSnapshotSpillPaths(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const match of content.matchAll(SNAPSHOT_SPILL_PATH_RE)) {
    const name = match[1]
    /* v8 ignore next -- the filename capture is required and non-empty whenever the spill regex matches */
    if (name === undefined) continue
    result.set(name, match[0])
  }
  return result
}

/** Convert separators only inside generated path-bearing text markers. */
function canonicalizeEmbeddedPaths(value: string): string {
  return value
    .replace(PATH_TAG_RE, (_match, open: string, path: string, close: string) =>
      `${open}${path.replaceAll('\\', '/')}${close}`)
    .replace(ADDITIONAL_INSTRUCTIONS_PATH_RE, (_match, prefix: string, path: string) =>
      `${prefix}${path.replaceAll('\\', '/')}`)
}

/** Inputs the normalizers need to recognize a run's volatile values. */
export interface NormalizeContext {
  /** The session id(s) the run issued — replaced with `{{sessionId}}`. */
  sessionIds: string[]
  /** The generated cwd the run used — replaced with `{{cwd}}`. */
  cwd: string
  /** Other filesystem spellings of the same cwd (for example Windows short and long paths). */
  cwdAliases?: readonly string[]
}

/** How cwd-rooted path separators are represented after the cwd is tokenized. */
export type CwdPathMode = 'canonical' | 'native'

/** Optional controls shared by stdout and session-log normalization. */
export interface NormalizeOptions {
  /** Use `/` for shared goldens, or preserve captured separators for a platform-specific golden. */
  cwdPathMode?: CwdPathMode
  /** Keep already-redacted typed ids and arbitrary UUID-like prose unchanged. */
  identityMode?: 'legacy' | 'preserve'
}

/** Return every known spelling of the generated cwd, most specific first. */
function cwdSpellings(ctx: NormalizeContext): string[] {
  const spellings = [...new Set([ctx.cwd, ...ctx.cwdAliases ?? []])]
    .filter(spelling => spelling.length > 0)
  const macAliases = spellings
    .filter(spelling => spelling.startsWith('/') && !spelling.startsWith('/private/'))
    .map(spelling => `/private${spelling}`)
  return [...new Set([...spellings, ...macAliases])]
    .sort((left, right) => right.length - left.length)
}

/** Whether an embedded cwd match starts and ends at a path/text boundary. */
function isCwdMatch(value: string, start: number, length: number): boolean {
  const before = value[start - 1]
  const after = value[start + length]
  const afterPunctuation = value[start + length + 1]
  const startsAtBoundary = before === undefined
    || PATH_TEXT_BOUNDARY_RE.test(before)
    || FILE_URI_PATH_PREFIX_RE.test(value.slice(0, start))
  const endsAtBoundary = after === undefined
    || after === '/'
    || after === '\\'
    || PATH_TEXT_BOUNDARY_RE.test(after)
    || after === '.' && (afterPunctuation === undefined || PATH_TEXT_BOUNDARY_RE.test(afterPunctuation))
  return startsAtBoundary && endsAtBoundary
}

/** Replace one cwd spelling without matching a longer path segment that merely shares its prefix. */
function replaceCwdSpelling(value: string, spelling: string, replacement: string): string {
  let cursor = 0
  let out = ''
  while (cursor < value.length) {
    const match = value.indexOf(spelling, cursor)
    if (match < 0) return out + value.slice(cursor)
    const end = match + spelling.length
    if (isCwdMatch(value, match, spelling.length)) {
      out += value.slice(cursor, match) + replacement
      cursor = end
    } else {
      out += value.slice(cursor, end)
      cursor = end
    }
  }
  return out
}

/** Replace every known cwd spelling with one stable token. */
function replaceCwd(value: string, ctx: NormalizeContext, replacement: string): string {
  let out = value
  for (const spelling of cwdSpellings(ctx)) out = replaceCwdSpelling(out, spelling, replacement)
  return out
}

/** Replace cwd, session ids, and any stray UUID with stable tokens in a string. */
function scrubString(
  value: string,
  ctx: NormalizeContext,
  cwdPathMode: CwdPathMode,
  identityMode: 'legacy' | 'preserve',
): string {
  let out = replaceCwd(value, ctx, CWD)
  // Filesystem APIs can report one directory with several spellings. Replace
  // every known spelling longest-first so a shorter alias cannot corrupt a
  // longer one before it is tokenized. macOS additionally symlinks
  // /tmp → /private/tmp and /var → /private/var: the session header cwd may
  // omit the /private prefix while fs tools resolve symlinks, so cover the
  // prefixed form of every spelling too, then collapse a residual prefixed
  // token.
  out = out.split(`/private${CWD}`).join(CWD)
  if (cwdPathMode === 'canonical') {
    // Restrict separator conversion to paths rooted at the cwd token. A global
    // backslash rewrite would corrupt regexes, commands, and model-authored text.
    out = out.replace(CWD_ROOTED_PATH_RE, path => path.replaceAll('\\', '/'))
    out = canonicalizeEmbeddedPaths(out)
  }
  out = out.replace(LOCAL_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  out = out.replace(SNAPSHOT_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  // Exact event-read results render the target as pretty JSON inside a
  // distinctive envelope. Restrict time scrubbing to that fenced target so
  // neighbor, model, bash, and unrelated tool text remains regression-visible.
  if (EVENT_READ_TARGET_REGION_RE.test(out)) {
    out = out.replace(
      EVENT_READ_TARGET_REGION_RE,
      target => target.replace(EMBEDDED_EVENT_TIME_RE, `$1${EVENT_TIME}`),
    )
    out = out.replace(EVENT_READ_OMITTED_BYTES_RE, `$1${EVENT_OMITTED_BYTES}$2`)
  }
  if (identityMode === 'legacy') {
    for (const id of ctx.sessionIds) out = out.split(id).join(SESSION_ID)
    out = out.replace(UUID_RE, SESSION_ID)
  }
  return out
}

/** Recursively scrub a parsed JSON value (strings replaced; structure kept). */
function scrubValue(
  value: unknown,
  ctx: NormalizeContext,
  cwdPathMode: CwdPathMode,
  identityMode: 'legacy' | 'preserve',
  key?: string,
): unknown {
  if (typeof value === 'string') {
    if (identityMode === 'legacy' && key === 'messageId') return MESSAGE_ID
    const scrubbed = scrubString(value, ctx, cwdPathMode, identityMode)
    return cwdPathMode === 'canonical' && key === 'path' ? scrubbed.replaceAll('\\', '/') : scrubbed
  }
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx, cwdPathMode, identityMode))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, ctx, cwdPathMode, identityMode, k)
    if (
      (value as { sessionUpdate?: unknown }).sessionUpdate === 'usage_update'
      && typeof (value as { used?: unknown }).used === 'number'
    ) out.used = USED_TOKENS
    return out
  }
  return value
}

/** Escape one literal path segment for use in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace any absolute spelling whose final segment is the generated cwd basename. */
function tokenizeFixtureString(value: string, ctx: NormalizeContext, basename: string): string {
  const exact = replaceCwd(value, ctx, CWD)
  const absoluteCwd = new RegExp(
    String.raw`(?:[A-Za-z]:)?[\\/](?:[^\\/\s<>"]+[\\/])*${escapeRegExp(basename)}`
    + String.raw`(?=$|[\\/\s<>'"()\[\]{},;:!?=])`,
    'g',
  )
  return exact.replace(absoluteCwd, CWD).split(`/private${CWD}`).join(CWD)
}

/** Recursively replace generated-cwd spellings while preserving every other JSON value. */
function tokenizeFixtureValue(
  value: unknown,
  ctx: NormalizeContext,
  basename: string,
): unknown {
  if (typeof value === 'string') return tokenizeFixtureString(value, ctx, basename)
  if (Array.isArray(value)) return value.map(item => tokenizeFixtureValue(item, ctx, basename))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      tokenizeFixtureValue(item, ctx, basename),
    ]))
  }
  return value
}

/**
 * Store one generated workspace as `{{cwd}}` while retaining every other
 * session value. The caller opts in only for workspaces created under a
 * platform temporary root; explicitly relocated workspaces keep their real
 * path.
 *
 * @param rawLog The raw or refresh-stabilized session JSONL fixture.
 * @returns Compact JSONL whose known cwd spellings become `{{cwd}}`.
 * @throws If a non-empty line is invalid JSON or the session cwd has no basename.
 */
export function tokenizeSessionFixtureCwd(rawLog: string): string {
  const lines = rawLog.split('\n')
  const firstLine = lines.find(line => line.trim().length > 0)
  const header = firstLine === undefined ? undefined : JSON.parse(firstLine) as { cwd?: unknown }
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const basename = cwd.split(/[\\/]/).at(-1)
  if (basename === undefined || basename.length === 0) {
    throw new Error('acp-snapshot: cannot tokenize a cwd without a basename')
  }
  const ctx: NormalizeContext = { sessionIds: [], cwd }
  return lines.map((line) => {
    if (line.trim().length === 0) return line
    return JSON.stringify(tokenizeFixtureValue(JSON.parse(line), ctx, basename))
  }).join('\n')
}

/**
 * Normalize a raw stdout transcript (newline-delimited JSON-RPC frames) into a stable expected output
 * in the same shape as the wire: one compact JSON frame per line (NDJSON), with the JSON-RPC
 * `id` rewritten to a per-transcript sequence (1, 2, 3, …) and all volatile strings scrubbed.
 * Invalid JSON throws, doubling as a protocol-stdout purity check.
 *
 * @param rawStdout The captured stdout bytes, decoded utf8.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized NDJSON transcript, one frame per line.
 */
export function normalizeStdout(
  rawStdout: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const identityMode = options.identityMode ?? 'legacy'
  const lines = rawStdout.split('\n').filter(line => line.trim().length > 0)
  // Map each distinct JSON-RPC id (request/response correlate by id) to a stable
  // sequence number, in first-seen order, so id churn doesn't perturb the expected output.
  const idSeq = new Map<string, number>()
  const stableId = (id: unknown): number => {
    const key = JSON.stringify(id)
    let n = idSeq.get(key)
    if (n === undefined) { n = idSeq.size + 1; idSeq.set(key, n) }
    return n
  }
  const frames = lines.map((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>
    if ('id' in frame && frame.id !== undefined && frame.id !== null) {
      frame.id = stableId(frame.id)
    }
    return scrubValue(frame, ctx, cwdPathMode, identityMode) as Record<string, unknown>
  })
  return frames.map(f => JSON.stringify(f)).join('\n') + '\n'
}

/**
 * Normalize a session JSONL log into a stable expected output: the header line's
 * volatile fields (`createdAt`, `id`, `cwd`) are zeroed/scrubbed; event,
 * historical packed-row, embedded Assistant-stream, and goal lifecycle clocks
 * are zeroed; and all volatile strings are scrubbed. Projected inputs remain
 * projected. Packed `data.dt` gaps are normalized even when the projected row
 * omits its `time0` anchor.
 * Output is JSONL in the same shape as the input — one compact record per
 * line.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized JSONL log, one record per line.
 */
export function normalizeSessionLog(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const identityMode = options.identityMode ?? 'legacy'
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const records = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.type === 'session') {
      if ('createdAt' in record) record.createdAt = 0
    } else if (isPackedFixtureRow(record)) {
      if ('time0' in record) record.time0 = 0
      const data = record.data
      if (data !== null && typeof data === 'object' && Array.isArray((data as { dt?: unknown }).dt)) {
        (data as { dt: unknown[] }).dt = (data as { dt: unknown[] }).dt.map(() => 0)
      }
    } else if ('time' in record) {
      record.time = 0
    }
    if ((record.type === 'assistant/message' || record.type === 'assistant/attempt')
      && record.data !== null && typeof record.data === 'object') {
      const stream = (record.data as { stream?: unknown }).stream
      if (Array.isArray(stream)) {
        for (const member of stream) {
          if (member === null || typeof member !== 'object') continue
          const timed = member as { time?: unknown; time0?: unknown; dt?: unknown }
          if (typeof timed.time === 'number') timed.time = 0
          if (typeof timed.time0 === 'number') timed.time0 = 0
          if (Array.isArray(timed.dt)) timed.dt = timed.dt.map(() => 0)
        }
      }
    }
    if (record.type === 'hook/result' && record.data !== null && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>
      if ('durationMs' in data) data.durationMs = 0
    }
    if (record.type === 'goal/change' && record.data !== null && typeof record.data === 'object') {
      const data = record.data as Record<string, unknown>
      if ('createdAt' in data) data.createdAt = 0
      if ('updatedAt' in data) data.updatedAt = 0
    }
    if (Object.hasOwn(record, 'sourceEventSeqs')) {
      record.sourceEventSeqs = decodeSeqRanges(record.sourceEventSeqs)
    }
    return scrubValue(record, ctx, cwdPathMode, identityMode) as Record<string, unknown>
  })
  return records.map(r => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * Canonicalize projected v2 body records. Compact streams are nested event data,
 * so persistence flush boundaries cannot change the row layout.
 */
function projectSessionSnapshot(rawLog: string): string {
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const header = lines.shift() as string

  const body = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    const projected = { ...record }
    omitFixtureEnvelope(projected)
    return JSON.stringify(projected)
  })
  return [header, ...body, ''].join('\n')
}

/**
 * Normalize and project persisted session JSONL for a committed fixture.
 * This composes ordinary log normalization with request-header scrubbing and
 * persistence-envelope projection, then writes the v2 logical event stream as
 * one record per event, independent of persistence flush boundaries.
 *
 * @param rawLog - persisted or already-projected session JSONL.
 * @param ctx - the run's volatile values to scrub.
 * @param options - separator output controls.
 * @returns normalized committed session snapshot JSONL.
 */
export function normalizeSessionSnapshot(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  return projectSessionSnapshot(scrubSessionSnapshot(normalizeSessionLog(rawLog, ctx, options)))
}

/**
 * Normalize one scenario's primary and child logs with shared typed identity redaction.
 * @param rawLogs - primary-first persisted or projected session JSONL.
 * @param ctx - generated cwd spellings and other volatile run facts.
 * @param options - separator controls; relationship-preserving identity mode is mandatory.
 * @returns normalized session fixtures in input order.
 */
export function normalizeSessionSnapshots(
  rawLogs: readonly string[],
  ctx: NormalizeContext,
  options: Omit<NormalizeOptions, 'identityMode'> = {},
): string[] {
  const currentLogs = rawLogs.map(log => hasSessionFormatVersion(log)
    ? prepareSessionSnapshotFixtureForComparison(log)
    : log)
  const comparableLogs = currentLogs.map(normalizeSessionFormatProvenance)
  return redactSessionSnapshotIds(comparableLogs).map(log => projectSessionSnapshot(
    scrubSessionSnapshot(normalizeSessionLog(
      log,
      { ...ctx, sessionIds: [] },
      { ...options, identityMode: 'preserve' },
    )),
  ))
}

/**
 * Omit only generation-qualified operational provenance from expected-output comparison.
 * @param rawLog - Session records or events as compact JSON lines.
 * @returns the same records without delivery or captured-source generation qualifiers.
 */
export function normalizeSessionFormatProvenance(rawLog: string): string {
  return rawLog.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    let changed = normalizeCapturedFormatProvenance(record)
    if (record.type === 'session' && Object.hasOwn(record, 'version')) {
      delete record.version
      changed = true
    }
    if (record.type === 'session-log-deepseek/delivery-accepted'
      && record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)) {
      const data = { ...record.data as Record<string, unknown> }
      if (Object.hasOwn(data, 'sessionFormatVersion')) {
        delete data.sessionFormatVersion
        record.data = data
        changed = true
      }
    }
    return changed ? JSON.stringify(record) : line
  }).join('\n')
}

/** Omit captured generations only from an actual current Message source position. */
function normalizeCapturedFormatProvenance(event: Record<string, unknown>): boolean {
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return false
  const data = event.data as Record<string, unknown>
  const message = event.type === 'user/message'
    ? data
    : event.type === 'assistant/message' || event.type === 'tool/result'
      ? data.message
      : undefined
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false
  const source = (message as Record<string, unknown>).source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false
  const record = source as Record<string, unknown>
  if (record.kind !== 'session-reference' || record.form !== 'recall' || record.version !== 1
    || !Array.isArray(record.references)) return false
  let changed = false
  for (const reference of record.references) {
    if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) continue
    const captured = reference as Record<string, unknown>
    if (Object.hasOwn(captured, 'capturedFormatVersion')) {
      delete captured.capturedFormatVersion
      changed = true
    }
  }
  return changed
}

/** Whether a fixture declares a released Session format and therefore participates in migration burn-in. */
function hasSessionFormatVersion(rawLog: string): boolean {
  const firstLine = rawLog.split(/\r?\n/).find(line => line.trim().length > 0)
  if (firstLine === undefined) throw new Error('session snapshot must start with a session header')
  const header = JSON.parse(firstLine) as unknown
  if (header === null || typeof header !== 'object' || Array.isArray(header)
    || (header as Record<string, unknown>)['type'] !== 'session') {
    throw new Error('session snapshot must start with a session header')
  }
  return Object.hasOwn(header, 'version')
}

/**
 * Replace system-prompt content in request headers with `{{system}}` tokens
 * while retaining field presence.
 * Other header content stays verbatim, so a header-pinning fixture can keep
 * its complete tool schemas while every JSONL fixture omits the prompt text.
 * Lines without a system payload pass through byte-for-byte; the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with system-prompt content tokenized.
 */
export function scrubSystemPrompts(rawLog: string): string {
  return scrubHeaderContent(rawLog, { system: true })
}

/**
 * Replace tool schemas in full request-header snapshots with `{{tools}}`
 * tokens while retaining field presence. System prompts and session-prefix
 * messages stay verbatim so pinning fixtures can move only schema bulk into
 * their dedicated JSON sidecar. Lines without a tool payload pass through
 * byte-for-byte; the transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with tool-schema content tokenized.
 */
export function scrubToolSchemas(rawLog: string): string {
  return scrubHeaderContent(rawLog, { tools: true })
}

/**
 * Replace all bulky request-header content in a session JSONL with stable
 * tokens. This includes the system-prompt fields handled by
 * {@link scrubSystemPrompts}, tool schemas, and session-prefix messages. It
 * keeps prefix message counts, field presence, config, and reason. Lines
 * without content to scrub pass through byte-for-byte, and the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with all header bulk tokenized, other lines byte-identical.
 */
export function scrubRequestHeaders(rawLog: string): string {
  return scrubHeaderContent(rawLog, { system: true, tools: true })
}

/**
 * Project a persisted session log while tokenizing all request-header bulk.
 * Each non-empty line is parsed at most once; the session header stays
 * byte-identical. Body records omit their persistence-only envelopes, and
 * request-header payloads are tokenized.
 *
 * @param rawLog - persisted or already-projected session JSONL.
 * @returns committed snapshot JSONL with request headers tokenized.
 */
export function scrubSessionSnapshot(rawLog: string): string {
  const scrubbed = scrubRequestHeaders(rawLog)
  let recordIndex = 0
  return scrubbed.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    if (recordIndex++ === 0) {
      if (record.type !== 'session') throw new Error('session snapshot must start with a session header')
      return line
    }
    omitFixtureEnvelope(record)
    return JSON.stringify(record)
  }).join('\n')
}

/** Which independent request-header payloads a scrubber replaces. */
interface HeaderScrubOptions {
  system?: boolean
  tools?: boolean
}

/** Transform the selected request-header payloads. */
function scrubHeaderContent(rawLog: string, options: HeaderScrubOptions): string {
  const lines = rawLog.split('\n')
  const out = lines.map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    const data = record.data as Record<string, unknown> | null | undefined
    if (data === null || typeof data !== 'object') return line
    if (record.type === 'request/header') {
      const header = data.header as Record<string, unknown> | null | undefined
      if (header === null || typeof header !== 'object') return line
      let touched = false
      if (options.system === true && 'system' in header) { header.system = SYSTEM; touched = true }
      if (options.tools === true && 'tools' in header) { header.tools = TOOLS; touched = true }
      return touched ? JSON.stringify(record) : line
    }
    return line
  })
  return out.join('\n')
}
