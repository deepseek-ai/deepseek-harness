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
  FactoryComponentPropsOf, FactoryLocalComponentPropsOf,
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ComposerBlock } from './composer-blocks.ts'
import type { DraftAttachmentId, InputActions, InputNotice, InputState } from './input.ts'
import type { ComposerKeyboard, EditSelection } from './draft-editor.ts'
import type { createConversationStore } from '../stores.ts'
import type { BusyEnterBehavior } from './composer-submission.ts'
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
  /**
   * Add one dropped batch through the composer's validation path.
   * @param files - dropped, pasted, or picked browser files in source order.
   * @param directories - members of `files` the drop source identified as directories.
   */
  onAddFiles: (files: readonly File[], directories?: ReadonlySet<File>) => void
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
  | {
    readonly attachment: ImageAttachmentRef
    /** Presentation-only name for the thumbnail and lightbox; loading uses the original reference. */
    readonly label?: string
  }
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
  /** Fixed, uncropped thumbnail for an attachment list row. */
  thumbnail?: boolean
}

/** Slot-backed renderer used by Conversation targets without importing an attachment implementation. */
export type RenderMessageImages = (owner: Omit<MessageImagesOwnerProps, 'loadImage'>) => ReactNode

/** Selector hook over the current Session's assembled Conversation. */
export type UseConversation = SnapshotSelectorHook<ConversationSnapshot>
/** Selector hook over the registered Conversation View roster. */
export type UseConversationViews = SnapshotSelectorHook<readonly ViewTab[]>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Conversation shell beneath its root-scoped main-panel entry. */
    'main.conversation': { kind: 'single'; scope: 'session-maybe' }
    /** Strict per-Session Conversation body. */
    'conversation.session': {
      kind: 'single'
      scope: 'session'
      owner: { view?: string }
    }
    /** Resident navigation container, including when no Session is selected. */
    'conversation.header': { kind: 'single'; scope: 'session-maybe' }
    /** Strict per-Session title, actions, and View navigation. */
    'conversation.session.header': {
      kind: 'single'
      scope: 'session'
      owner: {
        /** Parent-owned visibility shared with the header container styling. */
        hideChrome: boolean
      }
    }
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
    /** Global navigation before the Session title, available without a Session. */
    'conversation.header.leading': {
      kind: 'single'
      scope: 'root'
      owner: ConversationHeaderLeadingOwnerProps
    }
    /**
     * The header's far-right corner, past the utilities' edge and into the
     * header's own padding, for one control. The corner is laid out only while
     * its occupant renders something; an occupant with nothing to show renders
     * nothing, and the utilities take the header's edge.
     */
    'conversation.session.header.corner': {
      kind: 'single'
      scope: 'session'
      owner: ConversationHeaderCornerOwnerProps
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
    'conversation.hero.agentPreset': { kind: 'single'; scope: 'session-maybe'; owner: HeroAgentPresetOwnerProps }
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
    /** Compact action after the model selector; it can expand across the toolbar while retaining the editor and submit action. */
    'conversation.input.activity': { kind: 'single'; scope: 'session'; owner: InputActivityOwnerProps }
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
    /** Current-session permission control inside the composer tool row. */
    'conversation.input.permission': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
    /**
     * Model selector inside the composer tool row. When expanded controls cannot
     * share a line, the row sets --dsh-composer-model-text-display to none and
     * --dsh-composer-model-icon-display to block for an occupant's compact display.
     */
    'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }
  }

  interface SlotFactoryMap {
    /** Reusable Conversation content instantiated by presentation hosts. */
    'conversation.content': {
      scope: 'session-maybe'
      props: ConversationContentInputProps
      children: {
        'conversation.session': { kind: 'single'; scope: 'session' }
        'conversation.composer': { kind: 'chain'; scope: 'session' }
        'conversation.composer.bar': { kind: 'single'; scope: 'session-maybe' }
        'conversation.input.dock': { kind: 'list'; scope: 'session' }
        'conversation.hero.brand.mark': { kind: 'single'; scope: 'root' }
        'conversation.hero.workspace': { kind: 'single'; scope: 'root' }
        'conversation.hero.agentPreset': { kind: 'single'; scope: 'session-maybe' }
      }
      inject: ConversationInjected
      locale: 'conversation'
      slots: {
        views: { scope: 'session' }
        widthControls: { scope: 'root'; props: ConversationWidthControlsInputProps }
      }
    }
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

/** The header corner's occupant derives its state from standard Session props. */
export interface ConversationHeaderCornerOwnerProps {
  /** Marker field: the occupant receives no owner-specific values. */
  children?: never
}

/** The leading seat exposes global navigation independently of a Session. */
export interface ConversationHeaderLeadingOwnerProps {
  /** Marker field: the occupant receives no owner-specific values. */
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
  /** Open a tool call's inspector when an inspection target is available. */
  inspectCall: ((callId: string) => void) | undefined
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
  readonly hooks: {
    readonly conversationViews: ObservableSnapshot<readonly ViewTab[]>
    readonly inspectCall: ObservableSnapshot<ConvViewOwnerProps['inspectCall']>
  }
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
  /**
   * Register one picked batch; resolves to the rejection copy or null. Where
   * the browser shell reports host paths (the Desktop application), files
   * and folders with a real path become `@path` references in the draft
   * instead of uploads; `directories` names the members the drop source
   * identified as directories.
   */
  addFiles: ((files: readonly File[], directories?: ReadonlySet<File>) => string | null) | undefined
  removeAttachment: ((id: DraftAttachmentId) => void) | undefined
  resolveDraftAttachments: ((ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]) | undefined
  /** Restart one failed file upload; absent without a session. */
  retryFileUpload: ((id: DraftAttachmentId) => void) | undefined
  toggleCommandMenu: ((selection: EditSelection) => void) | undefined
  stop: (() => void) | undefined
  hooks: {
    /** Readable sequence while the fixed Stop command is registered. */
    stopShortcut: ObservableSnapshot<readonly string[]>
    /**
     * Live busy-state submission preference: the delivery mode plain Enter
     * and the primary Send button use while the addressed agent is busy.
     */
    busyEnter: ObservableSnapshot<BusyEnterBehavior>
    /** Live per-draft upload states for file-kind drafts. */
    fileUploads: ObservableSnapshot<DraftFileUploads>
    notices: ObservableSnapshot<InputNotice | null>
    lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
    menuLauncher: ObservableSnapshot<string | null>
  }
}

/** Owner share of the named plan, permission, and model controls. */
export interface InputControlOwnerProps {
  /** Whether the composer currently refuses interaction. */
  locked: boolean
}

/** A toolbar activity hides ordinary accessory controls while expanded; its occupant must release expansion on unmount. */
export interface InputActivityOwnerProps extends InputControlOwnerProps {
  /** @param active - whether the occupant needs the toolbar width before the submit action. */
  onActiveChange: (active: boolean) => void
}

/** Full props of the resident composer bar. */
export type ComposerBarProps =
  PropsRuntime<'conversation.composer.bar'>
  & PropsRenderSlots<
    | 'conversation.input.attachments' | 'conversation.input.overlay'
    | 'conversation.input.permission'
    | 'conversation.input.left' | 'conversation.input.plan'
    | 'conversation.input.right' | 'conversation.input.model' | 'conversation.input.activity'
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
  PropsRuntime<'main.conversation'>
  & PropsRenderSlots<'conversation.header'>
  & PropsRenderFactories

/** Inputs shared by main and embedded Conversation content occurrences. */
export interface ConversationContentInputProps {
  variant: 'main' | 'embedded'
  phase: 'settling' | 'hero' | 'active'
  hero: boolean
}

/** Values passed from shared content to its occurrence-selected width controls. */
export interface ConversationWidthControlsInputProps {
  /** Mounted Conversation body measured and styled by the selected controls. */
  container: HTMLDivElement | null
  /** Current body phase; handles render only for an active transcript. */
  phase: ConversationContentInputProps['phase']
}

/** Full props of the reusable Conversation Factory definition. */
export type ConversationContentProps = FactoryComponentPropsOf<'conversation.content'>

/** Shared target-neutral Conversation store handle. */
export type ConversationStore = ReturnType<typeof createConversationStore>

/** Full props of the Factory's caller-selectable Conversation View position. */
export type ConversationViewsProps = FactoryLocalComponentPropsOf<'conversation.content', 'views'>

/** Full props of the Factory's caller-selected width-control position. */
export type ConversationWidthControlsProps =
  FactoryLocalComponentPropsOf<'conversation.content', 'widthControls'>

/** Full props of the strict Session body. */
export type ConversationSessionSlotProps =
  PropsRuntime<'conversation.session'>
  & PropsRenderSlots<'conversation.view'>
  & PropsStore<ConversationStore>
  & InjectFace<ConversationSessionInjected>

/** Full props of the resident navigation header. */
export type ConversationHeaderProps =
  PropsRuntime<'conversation.header'>
  & PropsRenderSlots<'conversation.header.leading' | 'conversation.session.header'>

/** Full props of the strict Session header. */
export type ConversationSessionHeaderSlotProps =
  PropsRuntime<'conversation.session.header'>
  & PropsRenderSlots<
    'conversation.session.header.lineage'
    | 'conversation.session.header.actions'
    | 'conversation.session.header.utilities'
    | 'conversation.session.header.corner'
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
