/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @deepseek-ai/dsh-api-session-controller/client/sessions/remotes
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SubagentCatalog, SubagentInterruptReceipt, SubagentPromptReceipt, SubagentPromptRequest,
} from '@deepseek-ai/dsh-subagent/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemote } from '../transport.ts'

/** Narrow Commands namespace consumed by a Client Session. */
export interface SessionCommandsRemote {
  execute(
    agentId: SessionId,
    line: string,
    attachments: readonly CommandSubmitAttachment[],
    signal?: AbortSignal,
  ): Promise<RemoteResult<object | undefined>>
}

/** Narrow subagent namespace consumed by a Client Session and its manager. */
export interface SessionSubagentsRemote {
  list(parentSessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<SubagentCatalog>>
  prompt(
    request: SubagentPromptRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<SubagentPromptReceipt>>
  interruptByParent(
    childSessionId: SessionId,
    parentSessionId: SessionId,
    mode: 'continuable',
  ): Promise<RemoteResult<SubagentInterruptReceipt>>
}

/** Generated Remote namespaces consumed by the Client Session object layer. */
export interface SessionRemotes {
  readonly $stream: ClientRemote['$stream']
  readonly commands: SessionCommandsRemote
  readonly session: SessionRemote
  readonly subagents: SessionSubagentsRemote
}
