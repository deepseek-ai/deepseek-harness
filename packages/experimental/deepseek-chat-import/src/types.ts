/** Browser-safe wire types of the DeepSeek chat export importer. */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Only the owner may import; every other principal is refused. */
    'deepseekChatImport/owner-only': {}
  }
}

/** Why an import stopped as a whole. */
export type DeepseekChatImportFailureReason =
  | 'too-large'
  | 'unreadable-archive'
  | 'missing-manifest'
  | 'missing-index'
  | 'unsupported-version'
  | 'no-conversations'
  | 'workspace-not-found'
  | 'busy'

/** One conversation that was not imported. */
export interface DeepseekChatImportSkip {
  /** Conversation id from the export index, or the entry name when the file could not be parsed. */
  conversationId: string
  /** Title from the conversation file when it was parsed, otherwise null. */
  title: string | null
  /** English diagnostic naming the defect. */
  reason: string
}

/** Summary of one completed import. */
export interface DeepseekChatImportResult {
  /** Workspace that received the imported Sessions. */
  workspaceId: string
  /** Canonical directory of that Workspace, the working directory of every imported Session. */
  workspacePath: string
  /** Imported Sessions, newest first by the export index. */
  sessionIds: string[]
  /** Conversations the export index lists. */
  conversationCount: number
  /** Conversations the index lists that no attempt reached. */
  omittedByLimit: number
  /** Chosen conversations that could not be imported. */
  skipped: DeepseekChatImportSkip[]
}

/** Import limits the browser checks before uploading. */
export interface DeepseekChatImportLimits {
  /** Largest export archive, in bytes, one upload may carry. */
  maxUploadBytes: number
}

/** Final outcome of one upload. */
export type DeepseekChatImportResponse =
  | { ok: true; value: DeepseekChatImportResult }
  | { ok: false; error: { reason: DeepseekChatImportFailureReason; message: string } }

/**
 * One line of the upload route's `application/x-ndjson` answer: progress
 * lines while Sessions are written, then exactly one outcome line. A response
 * that ends without an outcome line was interrupted.
 */
export type DeepseekChatImportLine =
  | {
    type: 'progress'
    /** Sessions imported so far. */
    done: number
    /** Sessions the import tries to write: the configured limit or the number of valid conversations, whichever is smaller. */
    total: number
  }
  | { type: 'outcome'; outcome: DeepseekChatImportResponse }
