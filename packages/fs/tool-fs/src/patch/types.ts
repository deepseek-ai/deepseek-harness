/** Internal patch outcomes, failure diagnostics, and operation-local plans. */
import type { FsErrorCode, FsTarget } from '@deepseek-ai/dsh-fs'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** One request after the caller resolves its per-call sandbox policy. */
export interface PatchExecutionRequest {
  /** Raw patch text from the model. */
  patch: string
  /** Resolved per-call policy; undefined under an unconfined backend. */
  sandboxPolicy: SandboxExecutionPolicy | undefined
}

/** One file operation; unresolved paths retain their original patch spelling on resolution failure. */
export interface PatchOperationRecord {
  /** Zero-based position in the patch. */
  index: number
  /** File effect represented by this operation. */
  kind: 'add' | 'update' | 'delete' | 'move'
  /** Source display path (created path for add), or raw patch path if resolution failed. */
  path: string
  /** Move destination display path, or raw patch path if it could not be resolved. */
  destination?: string
  /** One-based patch line of the operation header. */
  patchLine: number
}

/** LF text before and after one effect; null means absence or an unavailable provider basis. */
export interface PatchFileChange {
  /** Canonical absolute process path that changed. */
  path: string
  /** Previous text, or null for absence or an unavailable basis. */
  before: string | null
  /** Published text, or null after deletion. */
  after: string | null
}

/** Filesystem failures plus syntax and disallowed symlink-source diagnostics. */
export type PatchFailureCode = FsErrorCode | 'PATCH_SYNTAX' | 'PATCH_SYMLINK_SOURCE'

/** Actionable diagnostic ready for model output. */
export interface PatchFailure {
  /** Stable machine-readable reason. */
  code: PatchFailureCode
  /** Message after sandbox denial mapping and filesystem remediation. */
  message: string
  /** Patch line of an unmatched hunk. */
  hunkLine?: number
}

/** One operation refused before any write. */
export interface PatchRefusal {
  operation: PatchOperationRecord
  failure: PatchFailure
}

/** Each operation retains completed effects even when a move fails halfway. */
export type PatchOperationOutcome =
  | { status: 'completed'; operation: PatchOperationRecord; changes: PatchFileChange[] }
  | { status: 'failed'; operation: PatchOperationRecord; failure: PatchFailure; changes: PatchFileChange[] }
  | { status: 'unknown'; operation: PatchOperationRecord; failure: PatchFailure }
  | { status: 'skipped'; operation: PatchOperationRecord }

/** Syntax and preflight refusals prevent all writes; a commit failure stops later operations. */
export type PatchExecutionReport =
  | { phase: 'syntax'; failure: PatchFailure }
  | { phase: 'preflight'; refusals: [PatchRefusal, ...PatchRefusal[]] }
  | { phase: 'commit'; outcomes: PatchOperationOutcome[]; affectedPaths: string[]; cancelled: boolean }

/** Resolved operation with raw source spelling retained for no-follow inspection. */
export type PlannedOperation = {
  record: PatchOperationRecord
  target: FsTarget
  rawPath: string
} & (
  | { kind: 'add'; content: string }
  | { kind: 'update'; hunks: readonly PatchHunk[] }
  | { kind: 'delete' }
  | { kind: 'move'; destination: FsTarget; hunks: readonly PatchHunk[] }
)

/** Resolved operations and path-resolution refusals in one parsed patch. */
export interface PatchPlan {
  /** Resolved operations in patch order. */
  operations: PlannedOperation[]
  /** Resolution refusals; unresolvable paths retain their raw patch spelling. */
  refusals: PatchRefusal[]
}
