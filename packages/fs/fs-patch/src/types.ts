/** Serializable patch syntax and text-application results; paths remain unresolved. */

/** One contiguous update. */
export interface PatchHunk {
  /** One-based input line containing the marker or first implicit hunk line. */
  lineNumber: number
  /** Text following `@@ `, used as a search anchor by the text matcher. */
  context?: string
  /** Context and removed lines, without patch prefixes or line endings. */
  oldLines: string[]
  /** Context and added lines, without patch prefixes or line endings. */
  newLines: string[]
  /** Whether `*** End of File` follows this hunk. */
  isEndOfFile: boolean
}

/** Ordered file operation; a move is an update with a destination path. */
export type PatchOperation =
  | {
    kind: 'add'
    path: string
    lineNumber: number
    /** Added lines joined with LF, including a final LF for every added line. */
    content: string
  }
  | {
    kind: 'delete'
    path: string
    lineNumber: number
  }
  | {
    kind: 'update'
    path: string
    lineNumber: number
    moveTo?: string
    hunks: PatchHunk[]
  }

/** The first hunk whose anchor or old lines could not be located in the original text. */
export interface HunkApplyFailure {
  /** One-based line of the failing hunk in the patch input. */
  hunkLineNumber: number
  /** The failed anchor or old-content search. */
  stage: 'context' | 'oldLines'
  /** Zero-based sequential search cursor; EOF searches override it with the tail candidate. */
  searchStart: number
  /** Original anchor or old lines, including any trailing empty line retried without its sentinel. */
  pattern: string[]
}

/** Complete new text or a match failure; failures contain no partially updated text. */
export type ApplyHunksResult =
  | { ok: true; after: string }
  | { ok: false; failure: HunkApplyFailure }
