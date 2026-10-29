/**
 * Vocabulary for the filesystem Service Definition (`ctx.fs`): the opaque target/version
 * identities, the metadata `stat` returns, the write-intent and outcome shapes, the
 * literal-edit request/outcome, and the typed error taxonomy.
 * @module @deepseek-ai/dsh-fs/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque key for stale guards and target lookup. The local backend uses a
 * realpath-like string; a remote backend might use a workspace URI or file id.
 * Consumers MUST NOT parse it or assume it is a local absolute path.
 */
export type FsTargetKey = Branded<'FsTargetKey'>

/**
 * Brand a string as an {@link FsTargetKey}. For backend use only — a consumer
 * never manufactures a key, it receives one from `resolve()`.
 * @param key - the backend's raw key string (the local backend passes a realpath).
 * @returns the same string, branded; no validation is performed.
 */
export function FsTargetKey(key: string): FsTargetKey {
  return key as FsTargetKey
}

/**
 * Opaque file-version token — the freshness token a write/edit guards against.
 * The local backend derives it from high-resolution stat identity and freshness
 * fields; a remote backend might use a revision id. The policy layer records it
 * for stale checks; consumers may display related metadata but MUST NOT
 * interpret this token.
 */
export type FsVersion = Branded<'FsVersion'>

/**
 * Brand a string as an {@link FsVersion}. For backend use only — a consumer
 * never manufactures a version, it receives one from `stat`/write/edit outcomes.
 * @param v - the backend's raw version string.
 * @returns the same string, branded; no validation is performed.
 */
export function FsVersion(v: string): FsVersion {
  return v as FsVersion
}

/**
 * One authoritative observation of a target. A present observation carries the
 * version used by guarded replacement; an absent observation authorizes only a
 * guarded create, never an edit.
 */
export type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }

/**
 * A path resolved by a backend into a stable identity. `resolve()` produces
 * this; every other operation takes it.
 */
export interface FsTarget {
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}

/**
 * Metadata about a target — what {@link FileSystem.stat} returns. Lets the
 * policy layer reject directories/special files before reading and choose
 * `readText` vs `streamText` from `size` without probing by failure. `version`
 * is the freshness token. `undefined` from `stat` means the target is absent.
 */
export interface FsInfo {
  /** Opaque freshness token of the target right now. */
  version: FsVersion
  /** Whether the target is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

/**
 * Metadata about a path without following the final path component when it is a
 * symbolic link. Unlike {@link FsInfo}, this path-level probe can report
 * `symlink` so consumers with trust-boundary rules can reject repository-owned
 * links before resolving a target.
 */
export interface FsPathInfo {
  /** Opaque freshness token of the path entry right now. */
  version: FsVersion
  /** Whether the path entry is a regular file, directory, symlink, or other. */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** Byte size of the path entry, when the backend can report it. */
  size?: number
}

/**
 * One direct child returned by {@link FileSystem.listDir}. Listing returns
 * metadata and resolved targets only; it must not read file contents.
 */
export interface FsDirEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Resolved child target for follow-up operations. */
  target: FsTarget
  /** Opaque freshness token when the backend can report metadata cheaply. */
  version?: FsVersion
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

/**
 * Guarded write intent. `createIfAbsent` rejects an existing target with
 * `FS_NOT_OBSERVED`; `replaceIfVersion` rejects absence or mismatch with
 * `FS_STALE_VERSION`. Omitting the intent from `writeText` means unconditional
 * create-or-overwrite, not a third union arm.
 */
export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

/** Outcome of a full-file write. */
export interface FsWriteOutcome {
  /** Whether the write created a new file or replaced an existing one. */
  operation: 'create' | 'update'
  /** Opaque version of the file after the write. */
  version: FsVersion
  /**
   * The file's content BEFORE the write, or `null` when the file did not exist
   * (a create) or the backend declined a contextual basis (for example, a
   * binary/non-UTF-8 prior file or either overwrite side reaching its exclusive limit).
   * LF-normalized storage text (the diff basis), never a diff — a consumer
   * computes the result-time contextual diff from `before`/`after` when
   * `before` is present, else falls back to a whole-file diff.
   */
  before: string | null
  /** The file's content AFTER the write, LF-normalized to share `before`'s diff basis. */
  after: string
}

/** A literal-replacement edit request. */
export interface FsEditRequest {
  /** Literal non-empty text to replace. Must match exactly (after line-ending normalization). */
  oldString: string
  /** Literal replacement text. An empty string deletes the matched text. */
  newString: string
  /** Replace every match instead of requiring exactly one. */
  replaceAll: boolean
}

/** Outcome of a literal edit. */
export interface FsEditOutcome {
  /** Opaque version of the file after the edit. */
  version: FsVersion
  /**
   * The file's content BEFORE the edit. Raw storage text (LF-normalized by the
   * backend), never a diff — a consumer computes the result-time contextual diff
   * (the applied hunk with context) from `before`/`after`.
   */
  before: string
  /** The file's content AFTER the edit. */
  after: string
}

/** Outcome of a guarded delete; the bounded basis follows FsWriteOutcome.before. */
export interface FsDeleteOutcome {
  /** LF-normalized removed content, or null for an unavailable, binary, or over-limit basis. */
  before: string | null
}

/** Serializable failure after a move has published its destination but retained its source. */
export interface FsMoveSourceFailure {
  /** Filesystem failure code for source removal. */
  code: FsErrorCode
  /** Diagnostic identifying the source and the failed removal. */
  message: string
}

/** Published destination and removal status; sourceBefore is the bounded LF source basis captured under the move lock. */
export type FsMoveOutcome =
  | { sourceBefore: string | null; destination: FsWriteOutcome; sourceDeleted: true }
  | { sourceBefore: string | null; destination: FsWriteOutcome; sourceDeleted: false; sourceFailure: FsMoveSourceFailure }

/** Stable filesystem failure codes shared by providers, consumers, and wire validators. */
export const FS_ERROR_CODES = [
  'FS_NOT_FOUND',
  'FS_NOT_DIRECTORY',
  'FS_NOT_TEXT',
  'FS_NOT_REGULAR_FILE',
  'FS_TOO_LARGE',
  'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED',
  'FS_IO_ERROR',
  'FS_STALE_VERSION',
  'FS_NOT_OBSERVED',
  'FS_AMBIGUOUS_EDIT',
  'FS_EDIT_NOT_FOUND',
  'FS_ABORTED',
  'FS_PATCH_MISMATCH',
  'FS_SAME_TARGET',
] as const

/** One machine-routable filesystem failure code from FS_ERROR_CODES. */
export type FsErrorCode = typeof FS_ERROR_CODES[number]

/**
 * Typed filesystem error. Extends {@link HarnessError} so it carries a stable
 * {@link FsErrorCode} and chains `cause`. `dsh-fs` owns this vocabulary so
 * backends and the policy layer raise the same codes instead of each inventing
 * message strings.
 */
export class FsError extends HarnessError {
  override readonly code: FsErrorCode

  constructor(message: string, code: FsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
