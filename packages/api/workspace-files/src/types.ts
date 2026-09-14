/**
 * Wire types of the `workspaceFiles` Remote namespace. Types only: generated
 * Remote clients consume this module without Host runtime code.
 *
 * Two path vocabularies leave here, and each method uses exactly one:
 *
 * - `read`, `readBytes`, `stat`, and `changes` name a file by its absolute path in the
 *   filesystem's execution world, because their consumer is the Client
 *   resource system, whose `dsh-resource://file/session/<id>/<path>` address carries that
 *   same path.
 * - `list` speaks workspace paths — the same syntax its `path` argument accepts —
 *   because its consumer is a tree rooted at the workspace root.
 *
 * @module @deepseek-ai/dsh-api-workspace-files/types
 */

// Import the protocol module so the declaration at the end of this file
// augments its error map rather than defining an unrelated ambient module.
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Identity and freshness of one workspace file, without its content. */
export interface WorkspaceFileStat {
  /**
   * Absolute path of the file in the filesystem's execution world, symlinks
   * resolved: `/`-separated on POSIX, drive-rooted with the platform separator
   * on Windows. What a `dsh-resource://file/absolute/…` address carries, and
   * what a `dsh-resource://file/session/<sessionId>/…` address's
   * workspace-relative path resolves to against that Session's root.
   */
  readonly absolutePath: string
  /** Opaque freshness token at the time of the stat; never parsed. */
  readonly version: string
  /** Byte size of the complete file, when the backend reports it. */
  readonly bytes?: number
}

/**
 * The line window one `read` returns. Lines are 1-based and end at `\n`; a
 * final `\n` terminates the last line rather than starting an empty one.
 */
export interface WorkspaceFileRange {
  /** First line of the page. Defaults to 1. */
  readonly offset?: number
  /** Largest number of lines on the page. Defaults to, and may not exceed, the configured `maxLines`. */
  readonly limit?: number
}

/** One page of a workspace text file as a Client reads it. */
export interface WorkspaceFileText extends WorkspaceFileStat {
  /** First line of the page, as requested. */
  readonly offset: number
  /**
   * The page's lines joined by `\n`, without a terminator after the last one.
   * Empty for a page past the file's last line and for a page holding one
   * empty line; `lines` tells them apart.
   */
  readonly text: string
  /** How many lines the page holds; `0` when `offset` lies past the file's last line. */
  readonly lines: number
  /** Whether the page includes the file's last line. */
  readonly eof: boolean
}

/** The byte window one `readBytes` returns. Offsets are 0-based. */
export interface WorkspaceByteRange {
  /** First byte of the window. Defaults to 0. */
  readonly offset?: number
  /** Largest number of bytes in the window. Defaults to, and may not exceed, the configured `maxBytes`. */
  readonly length?: number
}

/**
 * One byte window of a workspace file as a Client reads it: raw bytes, no text
 * decoding and no binary rejection. `bytes` is the complete file's size.
 */
export interface WorkspaceFileBytes extends WorkspaceFileStat {
  /** First byte of the window, as requested. */
  readonly offset: number
  /** The window's bytes in base64; empty when `offset` lies at or past the file's end. */
  readonly data: string
  /** Whether the window includes the file's last byte. */
  readonly eof: boolean
}

/** One direct child of a listed workspace directory. */
export interface WorkspaceDirectoryEntry {
  /** Basename inside the listed directory. */
  readonly name: string
  /**
   * What the child resolves to. A symlink reports the type of its destination,
   * and `other` covers everything that is neither a regular file nor a
   * directory; `read` still refuses a symlink, so `file` here is a listing fact,
   * not a promise that the content is readable.
   */
  readonly type: 'file' | 'directory' | 'other'
  /** Byte size, present only for a regular file whose backend reports it. */
  readonly size?: number
}

/** Direct children of one workspace directory. */
export interface WorkspaceDirectoryListing {
  /**
   * The listed directory as a workspace path, relative to the workspace root
   * and empty for the root itself. A child's path is this value joined with
   * {@link WorkspaceDirectoryEntry.name} by `/`.
   */
  readonly path: string
  /**
   * Direct children in the backend's stable name order, cut to the configured
   * entry cap. Presentation order is the caller's choice.
   */
  readonly entries: readonly WorkspaceDirectoryEntry[]
  /** Whether the entry cap dropped children from {@link entries}. */
  readonly truncated: boolean
}

/**
 * One observation of a workspace file made by an instrumented filesystem
 * operation. Frames report observations, not deltas: a consumer already
 * holding `version` learns nothing new from the frame and can ignore it.
 */
export type WorkspaceFileChange =
  | {
    /** Absolute path of the observed file, in the same form as {@link WorkspaceFileStat.absolutePath}. */
    readonly absolutePath: string
    /** Opaque freshness token after the observed operation; never parsed. */
    readonly version: string
  }
  | {
    /** Absolute path of the observed file, in the same form as {@link WorkspaceFileStat.absolutePath}. */
    readonly absolutePath: string
    /** The file was observed to be gone. */
    readonly absent: true
  }

/**
 * One frame of a workspace file watch generation. `ready` confirms that the
 * Host is observing filesystem operations and has resolved the workspace
 * root; observations queued during that resolution follow as `change` frames.
 */
export type WorkspaceFileWatchFrame =
  | { readonly kind: 'ready' }
  | { readonly kind: 'change'; readonly change: WorkspaceFileChange }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No entry exists at that path inside the workspace. */
    'workspace-file/not-found': { readonly path: string }
    /** The directory listing path resolves outside the session's workspace root. */
    'workspace-file/outside-workspace': { readonly path: string }
    /** The requested page exceeds the configured byte cap; nothing is returned. */
    'workspace-file/too-large': { readonly path: string; readonly limit: number }
    /** The content read so far is not decodable UTF-8 text, or the page carries NUL bytes. */
    'workspace-file/not-text': { readonly path: string }
    /** The path is not a regular file, so it has no text to read. */
    'workspace-file/not-regular-file': {
      readonly path: string
      readonly kind: 'directory' | 'symlink' | 'other'
    }
    /** The path is not a directory, so it has no children to list. */
    'workspace-file/not-directory': {
      readonly path: string
      readonly kind: 'file' | 'symlink' | 'other'
    }
  }
}
