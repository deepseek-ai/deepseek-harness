import type {
  ConversationNode, ConversationPromptSnapshot,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Operation that started a new append-only model context. */
export type ConversationContextOriginKind = 'compaction' | 'rewind' | 'rewrite'

/** One immutable model-context generation reconstructed from surface replacements. */
export interface ConversationContext {
  /** Zero-based generation within the session; stable across later appends. */
  id: number
  /** Previous generation in this session; absent for the initial context. */
  parentId?: number
  /** Why this generation exists; absent for the initial context. */
  origin?: ConversationContextOriginKind
  /** Event seq of the replacement that created this generation. */
  originSeq?: number
  /** Unix epoch ms of the replacement that created this generation. */
  createdAt?: number
  /** Latest request header observed in this generation, inherited until a later header replaces it. */
  prompt?: ConversationPromptSnapshot
  /** Final frozen nodes for historical generations, or current folded nodes for the tail. */
  nodes: readonly ConversationNode[]
}
