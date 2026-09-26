/** Chat-owned Slot declarations and composed component props. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  CommandNode, CompactionSummaryNode, ConversationLocationDataStore, ConversationTurnDataMap,
  ConversationGroupData, GroupSnapshot,
  MessageImageLoader, MessageImagesOwnerProps, RenderMessageImages, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  HostObservable, InjectFace, KeyedSnapshotSelectorHook, PropsLocale, PropsRenderSlots, PropsRuntime,
  PropsStore, SlotHookFactory, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createChatStore } from '../stores.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import type { ToolCallId } from './store.ts'
import type { ChatConversationViewNode, ChatNode, ChatNodeKind } from './chat-nodes.ts'
import type {
  ChatNodeProcessSource, ChatNodeSource, ChatSnapshot, ChatTurnProcessPresentation,
} from './snapshot.ts'
import type { TurnProcessSpec } from './turn-process.ts'
import type { PerformanceUsageMode } from '../../chat-settings.ts'

/** Selector hook over the current Conversation binding's Chat target. */
export type UseChat = SnapshotSelectorHook<ChatSnapshot>

/** Per-key selector hook over one Chat Node. */
export type UseChatNode = KeyedSnapshotSelectorHook<ChatConversationViewNode | undefined>

/** Per-key selector hook over one Chat Node's Turn-process presentation. */
export type UseChatNodeProcess = KeyedSnapshotSelectorHook<ChatTurnProcessPresentation | undefined>

/**
 * Selector hook over the live presentation policy. Callers select one field or
 * a derived conclusion, never the whole policy, so a mode change re-renders
 * only components whose selected value changed.
 */
export type UsePresentation = SnapshotSelectorHook<ChatPresentationPolicy>

/** Where in a file an open should land. */
export interface OpenFileOptions {
  /** 1-based line to reveal; absent = the file's beginning. */
  readonly line?: number
}

/** Owner currency of the completed-Turn extension chain. */
export interface TurnTailOwnerProps {
  turn: TurnLocation
  seq: number
  openFile: (path: string) => void
}

/** Owner currency of finalized-assistant actions. */
export interface AssistantActionOwnerProps {
  messageId: MessageId
}

/** Stable quota failure codes retained in the Session log; both raise the frame-wide notice. */
export type QuotaNoticeCode = 'QUOTA' | 'ACCOUNT_QUOTA'

/** The notice on display; `seq` keys remounts so an unretained later notice restarts its transient display. */
export interface QuotaNoticeState {
  /** Stable failure code retained in the Session log. */
  code: QuotaNoticeCode
  /** Per-publication sequence; the host keys its surface by it. */
  seq: number
}

/** Owner currency of one quota notice offered to the frame-wide chain. */
export interface QuotaNoticeOwnerProps {
  /** Stable failure code retained in the Session log. */
  code: QuotaNoticeCode
  /** Provider-neutral notice copy in the active locale. */
  message: string
  /** Take the notice down. */
  dismiss: () => void
  /**
   * Prevent later quota failures from replacing this notice. Dismissal clears
   * all holds; releasing the last hold resumes future notices without replay.
   * Callers must release on unmount.
   * @returns idempotent release that cannot clear another hold.
   */
  keepOpen: () => () => void
}

/** Quota notice host share: the notice on display and its dismissal. */
export interface QuotaNoticeInjected {
  hooks: {
    /** The notice on display, or none. */
    notice: HostObservable<QuotaNoticeState | null>
  }
  /** Take the notice down. */
  dismissNotice: () => void
  /**
   * Acquire a hold with the lifecycle defined by QuotaNoticeOwnerProps.keepOpen.
   * @returns idempotent release, or a no-op when no notice is live.
   */
  keepNoticeOpen: () => () => void
}

/** Full props of the Chat-owned frame-wide quota notice host. */
export type QuotaNoticeHostProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'chat'>
  & PropsRenderSlots<'shell.quota-notice'>
  & InjectFace<QuotaNoticeInjected>

/** Optional prose file-mention provider consumed by Chat. */
export interface ChatFileMentions {
  /**
   * Resolve prose links for one closing Turn.
   * @param owner - closing-Turn identity and file opener.
   * @param sessionId - viewed Session, including when history is inherited from a fork.
   * @returns link resolver when available.
   */
  forClosing(owner: TurnTailOwnerProps, sessionId: SessionId): MarkdownFileMentions | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional prose file-mention provider. */
    chatFileMentions: ChatFileMentions
  }
}

/** Hook constrained to business data published on the current Chat Node's Turn. */
export type UseChatNodeTurnData = <Key extends Extract<keyof ConversationTurnDataMap, string>>(
  key: Key,
) => Readonly<ConversationTurnDataMap[Key]> | undefined

/**
 * Subscribe to enclosing-Turn resets and own one initially collapsed disclosure.
 * Each invocation has independent open state; display-mode changes do not reset it.
 * @returns the current open state, explicit setter, and toggle action.
 */
export type UseDisclosure = () => {
  readonly expanded: boolean
  /** @param open - whether this disclosure is expanded. */
  readonly setExpanded: (open: boolean) => void
  readonly toggle: () => void
}

/** Stable sources bound to one rendered Chat Node. */
export interface ChatNodeHookContext {
  readonly turnData: ConversationLocationDataStore<ConversationTurnDataMap> | undefined
  readonly disclosureReset: ObservableSnapshot<number>
}

/** Slot-level Hook factories for keyed Chat renderers. */
export interface ChatNodeInjected {
  hooks: {
    turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData>
    disclosure: SlotHookFactory<'conversation.chat.node', UseDisclosure>
  }
}

/** Stable owner currency delivered to a keyed Chat renderer. */
export interface ChatNodeOwnerProps {
  /** Renderer-owned Node portion selected by the grouping Definition. */
  groupPart?: string
  cwd?: string | undefined
  /** Open the current source file of a skill referenced by a sent message. */
  openSkill: (name: string) => void
  openFile: (path: string, options?: OpenFileOptions) => void
  inspectCall: ((callId: ToolCallId) => void) | undefined
  forkAt: (seq: number) => void
  /**
   * Session-authorized image loader, down-threaded from the Chat view so a
   * chat-node renderer can render the attachment presentation slot directly
   * with only the durable references plus this loader, instead of receiving a
   * rendering closure.
   */
  loadImage: MessageImageLoader
  renderMessageImages: RenderMessageImages
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
  /** Turn-process state when this Node belongs to a projected Turn. */
  turnProcess?: TurnProcessOwnerProps | undefined
}

/** Shared presentation state for one Turn-process answer generation. */
export interface TurnProcessOwnerProps {
  /** Process content eligible to share one Turn-level disclosure. */
  readonly hasContent: boolean
  readonly spec: TurnProcessSpec
  readonly foldable: boolean
  readonly open: boolean
  setOpen(open: boolean): void
}

/** Shared presentation policy source for renderers that depend on the work-details mode. */
export interface PresentationInjected {
  hooks: {
    /** Live presentation policy derived from the accepted work-details mode. */
    presentation: ObservableSnapshot<ChatPresentationPolicy>
  }
}

/** Full props of one keyed Chat renderer. */
export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> =
  PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'chat'>

/** Command-row owner share. */
export interface CommandRowOwnerProps {
  node: CommandNode
  compaction?: CompactionSummaryNode
}

/** Full props of a registered command row. */
export type CommandRowProps = PropsRuntime<'conversation.chat.commandview'>

/** Shared Chat store handle. */
export type ChatStore = ReturnType<typeof createChatStore>

/** In-memory reader position resilient to transcript reflow. */
export interface ChatScrollPosition {
  readonly anchorKey: string
  readonly anchorTop: number
  readonly scrollTop: number
}

/** Shared settings source for the performance row, composer, and turn tail. */
export interface PerformanceUsageInjected {
  hooks: {
    /** Accepted performance and usage detail preference. */
    performanceUsage: ObservableSnapshot<PerformanceUsageMode>
  }
}

/** Business callbacks injected into the Chat view. */
export interface ChatViewInjected {
  hooks: {
    /** Live presentation policy derived from the accepted work-details mode. */
    presentation: ObservableSnapshot<ChatPresentationPolicy>
  }
  keyedHooks: {
    /** Resolve the stable source for one Chat Node key. */
    chatNode: (key: string) => ChatNodeSource
    /** Resolve the stable Turn-process source for one Chat Node key. */
    chatNodeProcess: (key: string) => ChatNodeProcessSource
    /** Resolve one optional group without subscribing the root View to its data. */
    chatGroup: (key: string) => ObservableSnapshot<GroupSnapshot<ConversationGroupData<'chat'>> | undefined> | undefined
  }
  /** Open the current source file of a skill referenced by a sent message. */
  openSkill: (name: string) => void
  /** Open one HTTP(S) message link at the selected destination, using an external tab if Sidebar Browser is unavailable. */
  openExternalLink: (url: string) => void
  openFile: (path: string, options?: OpenFileOptions) => Promise<void>
  loadOlder: () => void
  /** Jump loader: page history back through seq; resolves when the window covers it. */
  loadThrough: (seq: SessionSeq) => Promise<void>
  loadImage: MessageImageLoader
  chatScroll: {
    save: (position: ChatScrollPosition | null) => void
    read: () => ChatScrollPosition | null
  }
  forkAt: (seq: number) => void
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
}

/** Full Chat view props. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'>
  & PropsRenderSlots<'conversation.chat.node' | 'conversation.message.images'>
  & PropsStore<ChatStore>
  & InjectFace<ChatViewInjected>
  & PropsLocale<'chat'>

/** Full props of the durable-message image renderer. */
export type MessageImagesProps = PropsRuntime<'conversation.message.images'> & PropsLocale<'conversation'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Chat target. */
    useChat: UseChat
  }

  interface LocaleNamespaceMap {
    /** Chat target, transcript node, statistics, and details copy. */
    chat: import('../locale.ts').ChatKey
  }

  interface SlotMap {
    /**
     * Final Chat node renderer, keyed by `ChatNodeKind`. The component receives
     * the typed node, shared Chat actions, and Turn-data hook. Reusing a key
     * replaces that node renderer; a kind with no occupant renders no row.
     */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      owner: ChatNodeOwnerProps
      keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
      hookContext: ChatNodeHookContext
      inject: ChatNodeInjected
    }
    /**
     * Renderer for one consecutive group of durable message images. The owner
     * supplies image references, an authorized loader, and alignment. A
     * registration replaces the shipped gallery; without one, images are omitted.
     */
    'conversation.message.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /**
     * Command row keyed by the command name. The component receives the folded
     * command lifecycle and linked compaction when present. Reusing a key
     * replaces that command renderer; an unoccupied key uses the generic card.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * Ordered feature contributions before a completed Turn's action row. Each
     * entry receives the Turn, closing sequence, and file opener. A fresh `id`
     * adds an entry; entries without content return null.
     */
    'conversation.chat.turnTail': { kind: 'list'; scope: 'session'; owner: TurnTailOwnerProps }
    /**
     * Ordered actions for one finalized assistant message. Each entry receives
     * the durable message id; a fresh `id` adds an action and reusing one replaces
     * that entry. With no entries, the standard action row remains unchanged.
     */
    'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionOwnerProps }
    /**
     * Frame-wide quota notice chain. The Chat-owned host in `shell.overlay`
     * offers the one live notice; the first entry whose selector claims its
     * code takes over the surface, and the all-decline case renders the host's
     * generic warning Toast. The host lives outside the Chat panel, so a notice
     * survives switching or closing the panel that reported it.
     */
    'shell.quota-notice': { kind: 'chain'; scope: 'root'; owner: QuotaNoticeOwnerProps }
  }
}
