/** Semantic draft snapshots shared by storage, programmatic input, and editor restoration. */
import { z } from 'zod'
import type { DraftInput, DraftReference, DraftSnapshot, Occurrence } from './contract/draft-editor.ts'

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

const snapshotSchema = z.object({
  text: z.string(),
  references: z.array(referenceSchema),
}).refine((draft) => {
  let end = 0
  for (const reference of draft.references) {
    if (reference.offset < end || reference.length !== reference.clipboardText.length) return false
    end = reference.offset + reference.length
    if (end > draft.text.length || draft.text.slice(reference.offset, end) !== reference.clipboardText) return false
  }
  return true
}, 'Draft references must identify ordered, non-overlapping text spans')

/**
 * Copy input into the semantic draft representation without editor runtime identities.
 * @param input - plain text or caller-owned structured content.
 * @returns an owned snapshot ready for editor import.
 */
export function resolveDraftInput(input: DraftInput): DraftSnapshot {
  if (typeof input === 'string') return { text: input, references: [] }
  return { text: input.text, references: input.references.map(copyReference) }
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
    references: parsed.data.references.map(({ appearance, invalid, ...reference }) => ({
      ...reference,
      ...(appearance === undefined ? {} : { appearance }),
      ...(invalid === undefined ? {} : { invalid }),
    })),
  }
}

/**
 * Export reference identities without their editor-local occurrence ids.
 * @param text - current clipboard projection.
 * @param occurrences - matching reference projections from the same document revision.
 * @returns an editor-independent snapshot.
 */
export function snapshotDraft(text: string, occurrences: readonly Occurrence[]): DraftSnapshot {
  return {
    text,
    references: occurrences.map(copyReference),
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
