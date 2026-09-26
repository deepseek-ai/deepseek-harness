/**
 * File-reference discovery seam shared by host-backed user interfaces.
 *
 * @module @deepseek-ai/dsh-file-reference
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import type { FileReferenceCandidate } from './types.ts'

export { activeAtToken, formatFileMention } from './grammar.ts'
export type { ActiveAtToken } from './grammar.ts'
export type { FileReferenceCandidate } from './types.ts'

/** Model guidance for path-only references selected by a user interface. */
export const FILE_REFERENCE_PROMPT = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileReferences: FileReferenceService
  }
}

/** Host capability for cancellable file-reference discovery. */
export abstract class FileReferenceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileReferences')
  }

  /**
   * List file and directory candidates for one agent's working directory.
   * @param agent - target agent whose session cwd bounds discovery.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates.
   */
  abstract list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]>
}

export default FileReferenceService
