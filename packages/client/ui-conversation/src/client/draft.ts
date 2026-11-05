/** Semantic draft snapshots shared by storage, programmatic input, and editor restoration. */
import { z } from 'zod'
import { formatQuoteText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DraftInput, DraftQuote, DraftReference, DraftSnapshot, Occurrence } from './contract/draft-editor.ts'

const referenceSchema = z.object({
  source: z.string(),
  ref: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  label: z.string(),
  appearance: z.enum(['session', 'file', 'folder']).optional(),
  clipboardText: z.string(),
  invalid: z.boolean().optional(),
})

const commandSchema = z.object({
  token: z.string(),
})

const quoteSchema = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  text: z.string().refine(text => text.trim() !== ''),
})

const snapshotSchema = z.object({
  text: z.string(),
  references: z.array(referenceSchema),
  command: commandSchema.optional(),
  quotes: z.array(quoteSchema).optional(),
}).refine((draft) => {
  const spelling = draft.command?.token.trimEnd()
  if (spelling !== undefined && (!/^\/\S/u.test(spelling) || !draft.text.startsWith(spelling))) return false
  let end = spelling?.length ?? 0
  for (const reference of draft.references) {
    if (reference.offset < end || reference.length !== reference.clipboardText.length) return false
    end = reference.offset + reference.length
    if (end > draft.text.length || draft.text.slice(reference.offset, end) !== reference.clipboardText) return false
  }
  for (const quote of draft.quotes ?? []) {
    if (quote.length !== formatQuoteText(quote.text).length
      || draft.text.slice(quote.offset, quote.offset + quote.length) !== formatQuoteText(quote.text)) return false
  }
  end = spelling?.length ?? 0
  for (const span of [...draft.references, ...draft.quotes ?? []].sort((a, b) => a.offset - b.offset)) {
    if (span.offset < end) return false
    end = span.offset + span.length
    if (end > draft.text.length) return false
  }
  return true
}, 'Draft references must identify ordered, non-overlapping text spans after the leading command token')

/**
 * Copy input into the semantic draft representation without editor runtime identities.
 * @param input - plain text or caller-owned structured content.
 * @returns an owned snapshot ready for editor import.
 */
export function resolveDraftInput(input: DraftInput): DraftSnapshot {
  if (typeof input === 'string') return { text: input, references: [] }
  return {
    text: input.text,
    references: input.references.map(copyReference),
    ...(input.command === undefined ? {} : { command: { token: input.command.token } }),
    ...(input.quotes === undefined ? {} : { quotes: input.quotes.map(quote => ({ ...quote })) }),
  }
}

/**
 * Decode persisted drafts, accepting the earlier plain-string representation.
 * @param value - JSON value read from browser storage.
 * @returns the decoded draft, or undefined for invalid data.
 */
export function parseStoredDraft(value: unknown): DraftSnapshot | undefined {
  if (typeof value === 'string') return resolveDraftInput(value)
  const parsed = snapshotSchema.safeParse(value)
  if (!parsed.success) return undefined
  return {
    text: parsed.data.text,
    ...parsed.data.quotes === undefined ? {} : { quotes: parsed.data.quotes },
    references: parsed.data.references.map(({ appearance, invalid, ...reference }) => ({
      ...reference,
      ...(appearance === undefined ? {} : { appearance }),
      ...(invalid === undefined ? {} : { invalid }),
    })),
    ...(parsed.data.command === undefined ? {} : { command: { token: parsed.data.command.token } }),
  }
}

/**
 * Export reference identities without their editor-local occurrence ids.
 * @param text - current clipboard projection.
 * @param occurrences - matching reference projections from the same document revision.
 * @param commandToken - claim token of the command chip opening the document, if any.
 * @param quotes - atomic quotes from the same document revision.
 * @returns an editor-independent snapshot.
 */
export function snapshotDraft(
  text: string, occurrences: readonly Occurrence[], commandToken?: string, quotes: readonly DraftQuote[] = [],
): DraftSnapshot {
  return {
    text,
    references: occurrences.map(copyReference),
    ...(commandToken === undefined ? {} : { command: { token: commandToken } }),
    ...(quotes.length === 0 ? {} : { quotes: quotes.map(quote => ({ ...quote })) }),
  }
}

function copyReference(reference: DraftReference): DraftReference {
  return {
    source: reference.source,
    ref: reference.ref,
    offset: reference.offset,
    length: reference.length,
    label: reference.label,
    clipboardText: reference.clipboardText,
    ...(reference.appearance === undefined ? {} : { appearance: reference.appearance }),
    ...(reference.invalid === undefined ? {} : { invalid: reference.invalid }),
  }
}
