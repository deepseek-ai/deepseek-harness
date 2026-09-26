/**
 * Client-safe recursive catalog rows and browser continuation requests,
 * receipts, and failures.
 *
 * @module @deepseek-ai/dsh-subagent/control-types
 */

import type { PromptContentPart } from '@deepseek-ai/dsh-attachment/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the Workspace registry's archive-admission family map this runtime merges `subagent` into.
import type {} from '@deepseek-ai/dsh-workspace/types'

/**
 * Client-minted identity of one browser prompt, persisted on the exact accepted
 * message. It carries the Session Controller's `session-request-id` brand so a
 * subagent prompt and an ordinary Session prompt share one identity
 * vocabulary; that package depends on this one, so the brand is spelled here
 * rather than imported.
 */
export type SubagentPromptRequestId = Branded<'session-request-id'>

/** Shared child fields for recursive catalog listing. */
export type SubagentCatalogRow =
  & {
    /** The durable child session id, stable across Activations. */
    readonly id: SessionId
    /**
     * Whether recursive catalog listing observed a resident Session. This
     * does not encode a durable outcome or guarantee continuation delivery.
     */
    readonly activity: 'running' | 'inactive'
  } & (
    | {
      /** A terminal one-shot child. */
      readonly mode: 'one-shot'
      /** Optional durable creation label from the parent catalog. */
      readonly label?: string
    }
    | {
      /** A resumable conversation. */
      readonly mode: 'continuable'
      /** Durable creation label from the parent catalog. */
      readonly label: string
    }
  )

/**
 * One recursive catalog row. Traversal may also return diagnostics for
 * unknown catalog modes or unreadable child catalogs.
 */
export type SubagentListEntry =
  | SubagentCatalogRow & {
    readonly kind: 'child'
    /** Whether the child catalog contains a direct child. */
    readonly hasChildren: boolean
  }
  | {
    readonly kind: 'diagnostic'
    /** The candidate's session id. */
    readonly id: SessionId
    /**
     * `corrupt` means the child catalog read found invalid or conflicting
     * Session data; `unavailable` means it could not be read. Either failure
     * stops that branch. `unsupported` means the parent catalog records an
     * unknown child mode; its readable catalog is still traversed.
     */
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/** Durable parent/child browsing address; unknown mode is resolved when child history is read. */
export type SubagentAddress =
  & {
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
  }
  & (
    | { readonly mode: 'one-shot' }
    | { readonly mode: 'continuable' }
    | { readonly mode: 'unknown' }
  )

/** One human message addressed to a continuable direct child. */
export interface SubagentPromptRequest {
  /** Identity persisted on the accepted message, minted before the call. */
  readonly requestId: SubagentPromptRequestId
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  /** Required discriminator retained from the browser control address. */
  readonly mode: 'continuable'
  /** Whether this message queues a later turn or targets the nearest step. */
  readonly delivery: 'queue' | 'steer'
  /**
   * Browser prompt parts delivered as the child's user message. The Host
   * admits and persists image parts before delivery, so the wire never
   * carries a durable attachment reference the caller could fabricate.
   */
  readonly content: readonly PromptContentPart[]
  /** Optional browser zone sampled for this exact human prompt. */
  readonly clientTimeZone?: string
}

/** Inbox identity returned once the continuation accepts one human message. */
export interface SubagentPromptReceipt {
  readonly messageId: MessageId
}

/** Uniform acknowledgement that one interrupt request was admitted. */
export interface SubagentInterruptReceipt {
  readonly accepted: true
}

/**
 * Failure details the control surface answers with. Prompts and interrupts
 * share these failures with the Client Remote result.
 */
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** A subagent session delegated from this session (at any depth) is inside a turn. */
    subagent: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A browser-supplied zone is neither UTC nor a canonical IANA name. */
    'subagent/invalid-time-zone': { readonly value: string }
    /** No live Agent carries the addressed parent session. */
    'subagent/parent-unavailable': { readonly parentSessionId: SessionId }
    /** The addressed child cannot take a continuation. */
    'subagent/not-resumable': { readonly childSessionId: SessionId }
    /** The claimed parent does not own the addressed child. */
    'subagent/unauthorized': { readonly childSessionId: SessionId }
    /** Image admission or model image-capability refusal. */
    'subagent/attachment-invalid': { readonly reason: string }
    /** The child exists but its inbox cannot admit the message now. */
    'subagent/delivery-unavailable': { readonly childSessionId: SessionId }
  }
}
