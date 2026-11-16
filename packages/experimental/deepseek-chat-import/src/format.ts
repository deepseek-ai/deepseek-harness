/**
 * JSON validation for the DeepSeek chat export (`export_format_version: 3`).
 *
 * Only fields the importer reads are validated. Fragment types the importer
 * does not map are accepted unchecked so later exporter additions do not
 * reject otherwise importable conversations.
 */

import { z } from 'zod'

/** The only `manifest.json` format version this importer reads. */
export const SUPPORTED_EXPORT_FORMAT_VERSION = 3

/** `manifest.json`, the first archive entry. */
export const exportManifest = z.object({ export_format_version: z.number() })

/** One export timestamp, converted to epoch milliseconds so ordering never re-parses it. */
const exportTime = z.string().transform((value, ctx) => {
  const time = parseExportTime(value)
  if (time === undefined) {
    ctx.addIssue({ code: 'custom', message: 'invalid timestamp' })
    return z.NEVER
  }
  return time
})

/**
 * `chat_session_index.json`: one row per conversation, carrying the update
 * order the import selects by. The index's title, pinned flag, and message
 * count are not read and stay unvalidated.
 */
export const exportSessionIndex = z.array(z.object({
  id: z.string().min(1),
  inserted_at: exportTime,
  updated_at: exportTime,
}))

/** One validated conversation index row. */
export type ExportSessionIndexRow = z.infer<typeof exportSessionIndex>[number]

const fragmentEnvelope = z.looseObject({ type: z.string() })

const exportMessage = z.object({
  id: z.number().int().nonnegative(),
  parent_id: z.number().int().nonnegative().nullable(),
  role: z.enum(['USER', 'ASSISTANT']),
  status: z.string(),
  inserted_at: z.string(),
  fragments: z.array(fragmentEnvelope),
})

/**
 * `chat_sessions/{id}.json`: one conversation and its complete message tree.
 * `current_message_id` may be absent or null; branch selection then falls back
 * to the greatest message id.
 */
export const exportSessionFile = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  current_message_id: z.number().int().nonnegative().nullable().optional(),
  inserted_at: z.string(),
  messages: z.array(exportMessage),
})

/** One validated conversation file. */
export type ExportSessionFile = z.infer<typeof exportSessionFile>
/** One validated message-tree node. */
export type ExportMessage = z.infer<typeof exportMessage>
/** One fragment before type-specific validation. */
export type ExportFragmentEnvelope = z.infer<typeof fragmentEnvelope>

const optionalText = z.string().nullable().optional()
const optionalStage = z.number().int().nullable().optional()

const searchResult = z.object({
  url: z.string(),
  title: optionalText,
  snippet: optionalText,
  published_at: optionalText,
})

const readLinkResult = z.object({
  url: optionalText,
  title: optionalText,
})

const fileEntry = z.object({
  id: z.string(),
  file_name: z.string(),
  /** Declared byte size, shown on the synthetic file card; an archive without it reports 0 bytes. */
  file_size: z.number().int().nonnegative().optional().default(0),
  is_image: z.boolean(),
  export_path: z.string().nullable(),
})

// Fields the 2026-11-12 exporter added are optional: `export_format_version`
// does not change with field-level drift, so an archive exported before that
// date must still parse instead of losing its whole conversation. `TOOL_SEARCH`
// without a `status` behaves like `FINISHED`.
const knownFragment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REQUEST'), content: z.string() }),
  z.object({ type: z.literal('RESPONSE'), content: z.string() }),
  z.object({ type: z.literal('THINK'), content: z.string(), elapsed_secs: z.number().nonnegative().nullable().optional() }),
  z.object({ type: z.literal('TEMPLATE_RESPONSE'), content: z.string() }),
  z.object({
    type: z.literal('TOOL_SEARCH'), queries: z.array(z.string()), results: z.array(searchResult),
    status: z.string().optional(), stage_id: optionalStage,
  }),
  z.object({
    type: z.literal('TOOL_OPEN'), status: z.string(), url: z.string().nullable(), title: optionalText, stage_id: optionalStage,
  }),
  z.object({ type: z.literal('TOOL_FIND'), status: z.string(), pattern: z.string().optional(), stage_id: optionalStage }),
  z.object({ type: z.literal('READ_LINK'), results: z.array(readLinkResult) }),
  z.object({ type: z.literal('TOOL_IMAGE_SEARCH'), status: z.string(), results: z.array(z.unknown()), stage_id: optionalStage }),
  z.object({ type: z.literal('PARTIAL_FILE_READ'), ratio: z.number() }),
  z.object({ type: z.literal('TIP'), content: z.string() }),
  z.object({ type: z.literal('FILE'), files: z.array(fileEntry) }),
])

/** A fragment type the importer maps, with its fields validated. */
export type KnownFragment = z.infer<typeof knownFragment>
/** One `FILE` fragment entry. */
export type ExportFileEntry = z.infer<typeof fileEntry>
/** One `TOOL_SEARCH` result. */
export type ExportSearchResult = z.infer<typeof searchResult>

const KNOWN_FRAGMENT_TYPES: ReadonlySet<string> = new Set(knownFragment.options.map(option => option.shape.type.value))

/**
 * Validate one fragment whose type the importer maps.
 * @param fragment - fragment envelope from a validated message.
 * @returns the typed fragment, or undefined for a type the importer ignores.
 * @throws {z.ZodError} when a mapped fragment type lacks a required field.
 */
export function parseKnownFragment(fragment: ExportFragmentEnvelope): KnownFragment | undefined {
  return KNOWN_FRAGMENT_TYPES.has(fragment.type) ? knownFragment.parse(fragment) : undefined
}

/**
 * Parse an export timestamp: an RFC 3339 UTC string with 0, 3, 6, or 9 fractional digits.
 * @param value - timestamp text from the export.
 * @returns epoch milliseconds, or undefined when the text is not a valid timestamp.
 */
export function parseExportTime(value: string): number | undefined {
  const time = Date.parse(value)
  return Number.isSafeInteger(time) && time >= 0 ? time : undefined
}
