/** Target-neutral Conversation slot declarations and composed component props. */
import type { ReactNode, RefObject } from 'react'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  MaybeSnapshotSelectorHook, ObservableSnapshot, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ComposerBlock } from './composer-blocks.ts'
import type {
  ComposerKeyboard, DraftAttachmentId, EditSelection, InputActions, InputNotice, InputState,
} from './input.ts'
import type { createConversationStore } from '../stores.ts'
import type { ComposerSubmitGesture, InputSubmitMode } from './composer-submission.ts'
import type { ConversationSnapshot } from './snapshot.ts'
import type { ViewTab } from './views.ts'

/** Browser-owned draft attachment that has not crossed the durable Host boundary. */
export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment

/** Browser-owned image, base64-encoded into the prompt at send time. */
export interface ComposerImageAttachment {
  kind: 'image'
  id: DraftAttachmentId
  file: File
  previewUrl: string
  /** Intrinsic pixel width, filled asynchronously by the intake header probe. */
  width?: number
  /** Intrinsic pixel height, filled asynchronously by the intake header probe. */
  height?: number
}

/** Browser-owned generic file whose bytes upload to the Host as soon as it is picked. */
export interface ComposerFileAttachment {
  kind: 'file'
  id: DraftAttachmentId
  file: File
}

/** Upload lifecycle of one picked file draft (files upload on pick, not on send). */
export type DraftFileUpload =
  | { readonly status: 'uploading'; readonly loaded: number; readonly total?: number }
  | { readonly status: 'ready'; readonly receiptId: FileUploadReceiptId; readonly file: FileAttachmentRef }
  | { readonly status: 'error'; readonly message: string }

/** Per-draft upload states keyed by draft attachment id. */
export type DraftFileUploads = Readonly<Record<string, DraftFileUpload>>

/** Input state handed to the optional attachment presentation plugin. */
export interface ComposerAttachmentsOwnerProps {
  /** Browser-owned draft attachments in input order. */
  attachments: readonly ComposerAttachment[]
  /** Whether a document-level file drop may add attachments now. */
  canAcceptDrop: boolean
  /** Add one dropped batch through the composer's validation path. */
  onAddFiles: (files: readonly File[]) => void
  /** Remove one draft attachment through the Conversation service. */
  onRemoveAttachment: (id: DraftAttachmentId) => void
  /** Current per-draft upload states for file-kind attachments. */
  uploads: DraftFileUploads
  /** Restart one failed file upload. */
  onRetryFile: (id: DraftAttachmentId) => void
  /** Display-ready limits for the drop invitation. */
  dropLimits?: { readonly count: number; readonly size: string } | undefined
}

/**
 * One image inside a message record: a durable admitted reference, or the
 * local preview of a submission echo whose admission is still in flight.
 */
export type MessageImageSource =
  | { readonly attachment: ImageAttachmentRef }
  | {
    readonly preview: {
      /** Browser-owned preview URL (lifecycle stays with the submitter). */
      readonly url: string
      readonly name?: string
      /** Intrinsic pixel width, when the intake probe has resolved it. */
      readonly width?: number
      /** Intrinsic pixel height, when the intake probe has resolved it. */
      readonly height?: number
    }
  }

/** Durable image loader with an optional synchronous cache read. */
export type MessageImageLoader = ((attachment: ImageAttachmentRef) => Promise<string>) & {
  peek?: (attachment: ImageAttachmentRef) => string | undefined
}

/** Message image group handed to the optional attachment presentation plugin. */
export interface MessageImagesOwnerProps {
  /** Durable references or submission-echo previews in source order. */
  images: readonly MessageImageSource[]
  /** Session-authorized image URL loader for the durable arm. */
  loadImage: MessageImageLoader
  /** Horizontal placement inside the owning record. */
  align: 'start' | 'end'
  /** Force every image into the compact message-attachment tile size. */
  compact?: boolean
}

/** Slot-backed renderer used by Conversation targets without importing an attachment implementation. */
export type RenderMessageImages = (owner: Omit<MessageImagesOwnerProps, 'loadImage'>) => ReactNode

/** Selector hook over the current Session's assembled Conversation. */
export type UseConversation = SnapshotSelectorHook<ConversationSnapshot>
/** Selector hook over the registered Conversation View roster. */
export type UseConversationViews = SnapshotSelectorHook<readonly ViewTab[]>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Strict per-Session Conversation body. */
    'conversation.session': { kind: 'single'; scope: 'session' }
    /** Strict per-Session title, actions, and View navigation. */
    'conversation.session.header': { kind: 'single'; scope: 'session' }
    /** Optional replacement for one Session breadcrumb title. */
    'conversation.session.header.lineage': {
      kind: 'single'
      scope: 'session'
      owner: ConversationHeaderLineageOwnerProps
    }
    /** Title-adjacent Session actions in ascending order. */
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
      owner: ConversationHeaderActionOwnerProps
    }
    /** Right-aligned Session utilities in ascending order. */
    'conversation.session.header.utilities': {
      kind: 'list'
      scope: 'session'
      owner: ConversationHeaderActionOwnerProps
    }
    /** Registered Conversation target Views, rendered one at a time. */
    'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
    /** Selector-routed replacements for the current Session's resident composer. */
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: ComposerChainProps }
    /** Workspace picker shown by the blank-session Hero. */
    'conversation.hero.workspace': { kind: 'single'; scope: 'root'; owner: EmptyWorkspaceOwnerProps }
    /** Brand mark shown before the blank-session headline. */
    'conversation.hero.brand.mark': { kind: 'single'; scope: 'root'; owner: HeroBrandMarkOwnerProps }
    /** Agent-preset control staged for a New Session. */
    'conversation.hero.agentPreset': { kind: 'single'; scope: 'root'; owner: HeroAgentPresetOwnerProps }
    /** Full-width entries above the composer card. */
    'conversation.input.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
    /** Floating entries rendered inside the resident composer card. */
    'conversation.input.overlay': { kind: 'list'; scope: 'session' }
    /** Ambient entries below the composer card. */
    'conversation.composer.dock': { kind: 'list'; scope: 'session' }
    /** Compact controls at the left of the composer tool row. */
    'conversation.input.left': { kind: 'list'; scope: 'session' }
    /** Compact controls before the composer submit action. */
    'conversation.input.right': { kind: 'list'; scope: 'session' }
    /** Resident composer body, including the no-Session inert state. */
    'conversation.composer.bar': { kind: 'single'; scope: 'session-maybe'; owner: ComposerBarOwnerProps }
    /** Optional draft-attachment rail and drop target. */
    'conversation.input.attachments': {
      kind: 'single'
      scope: 'session-maybe'
      owner: ComposerAttachmentsOwnerProps
    }
    /** Plan control inside the composer tool row. */
    'conversation.input.plan': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
    /** Model selector inside the composer tool row. */
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
  }

  interface GlobalStandardProps {
    /** Workspace selector supplied by the independently loaded Workspace UI. */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  }

  interface SessionStandardProps {
    /** Selector hook over target-neutral Conversation assembly. */
    useConversation: UseConversation
    /** Selector hook over the Session input machine. */
    useInput: SnapshotSelectorHook<InputState>
    /** Stable public input actions for this Session. */
    inputActions: InputActions
  }

  interface SessionMaybeStandardProps {
    /** Selector hook whose values are absent without a current Session. */
    useConversation: MaybeSnapshotSelectorHook<ConversationSnapshot>
    /** Input values are absent without a current Session. */
    useInput: MaybeSnapshotSelectorHook<InputState>
    /** Input actions are absent without a current Session. */
    inputActions: InputActions | undefined
  }
}

/** Owner share of the Hero agent-preset control. */
export interface HeroAgentPresetOwnerProps {
  /** Marker field: the occupant owns its roster and staged selection. */
  children?: never
}

/** Header actions derive their state from standard Session props. */
export interface ConversationHeaderActionOwnerProps {
  /** Marker field: entries receive no owner-specific values. */
  children?: never
}

/** Plain breadcrumb data handed to the optional lineage renderer. */
export interface ConversationHeaderLineageOwnerProps {
  /** Session represented by this breadcrumb title. */
  lineageSessionId: SessionId
  /** Display title available to a combined title/control renderer. */
  displayTitle: string
  /** Navigate to an ancestor title when present. */
  openTitle?: () => void
}

/** Point-in-time owner values for composer extension entries. */
export interface InputZone {
  readonly session: SessionSnapshot
  readonly input: InputState
}

/** Conversation View entries obtain their data from registered standard hooks. */
export interface ConvViewOwnerProps {
  /** Focus request addressed to the selected View. */
  viewRequest: import('./views.ts').ConversationViewRequest | null
  /** Select a View and address one opaque focus identity to it. */
  openView: (view: string, focus: string) => void
  /** Acknowledge the current one-shot focus request. */
  completeViewRequest: () => void
}

/** Base props of one target-owned Conversation View entry. */
export type ConvViewProps = PropsRuntime<'conversation.view'>

/** Business callbacks injected into the resident Conversation shell. */
export interface ConversationInjected {
  /** Connect and open a blank Session in the selected Workspace. */
  selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** Session-addressed composer block source, or the stable absent source. */
  hooks: { composerBlock: ObservableSnapshot<ComposerBlock | undefined> }
}

/** Business callbacks injected into the strict Session body. */
export interface ConversationSessionInjected {
  /** Package-owned View roster source bound only for the Conversation body. */
  readonly hooks: { readonly conversationViews: ObservableSnapshot<readonly ViewTab[]> }
  /** Bind input draft persistence to the Session-owned store instance. */
  bindDraftMirror: (write: (text: string) => void) => () => void
  /** Select and activate one View while addressing an opaque focus request to it. */
  openView: (view: string, focus: string) => void
}

/** Business callbacks injected into the strict Session header. */
export interface ConversationSessionHeaderInjected {
  /** Package-owned View roster source bound only for the Conversation header. */
  readonly hooks: { readonly conversationViews: ObservableSnapshot<readonly ViewTab[]> }
  /** Select a Session through the Session Controller. */
  open: (sessionId: SessionId) => void
  /** Select and activate one registered Conversation View. */
  selectView: (view: string) => void
}

/** Owner share of the resident composer bar. */
export interface ComposerBarOwnerProps {
  /** Hero uses centered placement; composer uses the active bottom placement. */
  variant: 'hero' | 'composer'
  /** A feature-owned reason that makes message input inert while leaving model selection live. */
  blocked?: { readonly reason: string }
  /** Lock all message actions while preserving the resident composer surface. */
  disabled?: boolean
  /** Whether the shared Workspace picker is expanded. */
  workspacePickerOpen?: boolean
  /** Open the Workspace picker from the inert composer surface. */
  onRequestWorkspace?: () => void
  placeholder?: string
  /** Optional content rendered above the composer surface. */
  accessory?: ReactNode
}

/** Package-private operations injected into the resident composer bar. */
export interface ComposerBarInjected {
  keyboard: ComposerKeyboard | undefined
  addFiles: ((files: readonly File[]) => string | null) | undefined
  removeAttachment: ((id: DraftAttachmentId) => void) | undefined
  resolveDraftAttachments: ((ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]) | undefined
  /** Restart one failed file upload; absent without a session. */
  retryFileUpload: ((id: DraftAttachmentId) => void) | undefined
  resolveSubmitMode: (
    running: boolean,
    gesture: ComposerSubmitGesture,
    steeringAvailable: boolean,
  ) => InputSubmitMode
  toggleCommandMenu: ((selection: EditSelection) => void) | undefined
  stop: (() => void) | undefined
  command: ((line: string) => Promise<boolean>) | undefined
  hooks: {
    /** Live per-draft upload states for file-kind drafts. */
    fileUploads: ObservableSnapshot<DraftFileUploads>
    notices: ObservableSnapshot<InputNotice | null>
    lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
    menuLauncher: ObservableSnapshot<string | null>
  }
}

/** Owner share of the named plan and model controls. */
export interface InputControlOwnerProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
}

/** Full props of the resident composer bar. */
export type ComposerBarProps =
  PropsRuntime<'conversation.composer.bar'>
  & PropsRenderSlots<
    | 'conversation.input.attachments' | 'conversation.input.overlay'
    | 'conversation.input.left' | 'conversation.input.plan'
    | 'conversation.input.right' | 'conversation.input.model'
    | 'conversation.composer.dock'
  >
  & InjectFace<ComposerBarInjected>
  & PropsLocale<'conversation'>

/** Owner values used to elect a composer takeover. */
export interface ComposerChainProps {
  /** Current Session identity used by temporary business-owned entries. */
  sessionId: SessionId | undefined
  /** Current Session lifecycle state, absent without a selected Session. */
  session: SessionSnapshot | undefined
  /** Effective business-owned interaction awaiting the user in this Session. */
  pendingInteraction: SessionPendingInteraction | undefined
}

/** Presentation props supplied to the blank-session brand mark. */
export interface HeroBrandMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Host class preserving the surrounding mark geometry. */
  className?: string | undefined
}

/** Full props of the resident optional-Session Conversation shell. */
export type ConversationSlotProps =
  PropsRuntime<'conversation'>
  & PropsRenderSlots<
    | 'conversation.session' | 'conversation.session.header'
    | 'conversation.composer' | 'conversation.composer.bar'
    | 'conversation.input.dock'
    | 'conversation.hero.brand.mark'
    | 'conversation.hero.workspace'
    | 'conversation.hero.agentPreset'
  >
  & InjectFace<ConversationInjected>
  & PropsLocale<'conversation'>

/** Shared target-neutral Conversation store handle. */
export type ConversationStore = ReturnType<typeof createConversationStore>

/** Full props of the strict Session body. */
export type ConversationSessionSlotProps =
  PropsRuntime<'conversation.session'>
  & PropsRenderSlots<'conversation.view'>
  & PropsStore<ConversationStore>
  & InjectFace<ConversationSessionInjected>

/** Full props of the strict Session header. */
export type ConversationSessionHeaderSlotProps =
  PropsRuntime<'conversation.session.header'>
  & PropsRenderSlots<
    'conversation.session.header.lineage'
    | 'conversation.session.header.actions'
    | 'conversation.session.header.utilities'
  >
  & PropsStore<ConversationStore>
  & InjectFace<ConversationSessionHeaderInjected>
  & PropsLocale<'conversation'>

/** Full props of the draft-attachment renderer. */
export type ComposerAttachmentsProps =
  PropsRuntime<'conversation.input.attachments'> & PropsLocale<'conversation'>

/** Owner share common to blank-session Workspace pickers. */
export interface EmptyWorkspaceOwnerProps {
  open: boolean
  anchorRef?: RefObject<HTMLElement>
  /** Currently selected Workspace, when available. */
  selectedId?: WorkspaceId | undefined
  onPick: (workspaceId: WorkspaceId) => void
  onClose: () => void
}
