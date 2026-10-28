/** Browser Conversation assemble core, React adapter, shell, input, and text projection plugin. */
export type {} from './user-text/session-reference-rule.ts'

/** Declaration-merged node payloads; IDs also identify the corresponding keyed renderer. */
export interface UserTextDataMap {
  text: {
    /** Exact original substring; display transforms never change source text or UTF-16 coordinates. */
    readonly text: string
    /** Optional display-only text; absence renders the original substring, while an empty string hides it. */
    readonly display?: string
  }
}

/** Caller-supplied JSON business facts and text-transform flags, never services or actions; absent flags are disabled. */
export interface UserTextFacts {
  /** Collapse whitespace runs in ordinary display text to one space. */
  readonly collapseWhitespace: boolean
  /** Remove display whitespace only at the document's outer edges, without crossing business nodes. */
  readonly trimWhitespace: boolean
}

export type {
  UserTextDocumentInput, UserTextEvaluator, UserTextId, UserTextNode, UserTextRule, UserTextTransformContext,
} from './contract/user-text.ts'
export type { UserTextRegistry } from './conversation/user-text-registry.ts'
export { apply, Config, inject } from './apply.ts'
export type { Config as ConversationConfig } from './apply.ts'
export { UiConversation } from './conversation/assembly.ts'
export type { ConversationBinding } from './conversation/assembly.ts'
export type { ConversationGroupRegistry } from './conversation/group-registry.ts'
export type {
  ConversationGroupContext, ConversationGroupData, ConversationGroupDataMap,
  ConversationGroupDefinition, ConversationGroupedView, ConversationGroupInput,
  GroupKey, GroupNodePosition, GroupReference, GroupSnapshot, GroupUpdate, NodeChange, NodeKey,
  NodeReference, RenderEntry,
} from './contract/groups.ts'
export { ConversationController, UnsupportedImageMediaTypeError } from './service.ts'
export type { IConversation } from './service.ts'
export type {
  ConversationContextReader, ConversationLocation,
  ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataSource,
  ConversationLocationDataStore,
  ConversationMatch, ConversationMatchHandler, ConversationMatchResult, ConversationNodeContext,
  ConversationNodeDefinition, ConversationNodeDefinitionInput, ConversationPreviousContext, ConversationPublication,
  ConversationStartMatch,
  ConversationStepDataMap, ConversationTimelineSnapshot, ConversationTurnDataMap,
  ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode,
  ConversationViewSnapshotMap, ConversationViewSnapshotStore, StepLocation, TurnLocation,
} from './contract/conversation.ts'
export { EMPTY_CONVERSATION_SNAPSHOT, conversationPhase } from './contract/snapshot.ts'
export type {
  ConversationPhase, ConversationSnapshot,
} from './contract/snapshot.ts'
export type {
  AssistantBlock, AssistantMessageNode, AssistantProviderMetadataView, AssistantRequestConfig,
  AssistantTiming, CommandNode, CompactionSummaryNode, ContextMessageNode, ConversationNode,
  ModelRetryNode, PartialAssistant, PreparingToolCall, RunningToolCall, StartedToolCall, SteeringMessageNode, TodoItem,
  ToolCallBlock, ToolArgs, ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UnknownSurfaceNode,
  UserMessageNode,
} from './contract/records.ts'
export type {
  ContextProducerView, ContextRole, KnownContextForm,
} from './contract/context-producer.ts'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestPromptInspection, RequestPromptInspector, RequestView,
  SystemPromptNode,
} from './contract/request-inspection.ts'
export { inspectRequestPrompt } from './contract/request-inspection.ts'
export type { SystemPromptState, SystemPromptInspector } from './contract/system-prompt.ts'
export type { ConversationStoreState, ConversationViewRequest, ViewTab } from './contract/views.ts'

export { ConversationNodeAssembler } from './conversation/assembler.ts'
export type {
  ConversationEventDefinitions, ConversationGroupDefinitions, ConversationViewDefinitions,
} from './conversation/assembler.ts'
export { ConversationDefinitionRegistry } from './conversation/definition-registry.ts'
export { ConversationEventRegistry } from './conversation/event-registry.ts'
export { ConversationLocationIndex } from './conversation/location-index.ts'
export type { ConversationLocationDataChange } from './conversation/location-index.ts'
export { ConversationViewRegistry } from './conversation/view-registry.ts'

export type { ConversationKey } from './locales.ts'
export type {
  ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps,
  ComposerFileAttachment, ComposerImageAttachment, DraftFileUpload, DraftFileUploads,
  ComposerBarInjected, ComposerBarOwnerProps, ComposerBarProps, ComposerChainProps,
  ConversationHeaderActionOwnerProps, ConversationHeaderCornerOwnerProps, ConversationHeaderLineageOwnerProps,
  ConversationContentInputProps, ConversationContentProps,
  ConversationInjected, ConversationSessionHeaderInjected, ConversationSessionHeaderSlotProps,
  ConversationSessionInjected, ConversationSessionSlotProps, ConversationSlotProps,
  ConversationViewActionEntry, ConversationViewActionsOwnerProps, ConversationViewsProps,
  ConversationWidthControlsInputProps, ConversationWidthControlsProps,
  ConversationStore, ConvViewOwnerProps, ConvViewProps, EmptyWorkspaceOwnerProps,
  HeroAgentPresetOwnerProps, HeroBrandMarkOwnerProps, InputControlOwnerProps, InputZone,
  MessageImageLabels, MessageImageLoader, MessageImageSource, MessageImagesContentInput, MessageImagesOwnerProps, UseConversation,
  UserTextInput, UserTextInjected, UserTextNodeOwnerProps, UserTextNodeProps,
  UseConversationViews,
} from './contract/slots.ts'
export type {
  BeginCommandRequest, CommandClaim, ConsumeTokenRequest, DraftAttachmentId, DraftInitializationOptions,
  DraftInitializationResult, InputActions,
  InputState, InsertReferenceRequest, InsertTextRequest, PickOutcome, SessionInput,
  SessionInputResolver, SubmitAttachment, SubmitOutcome,
} from './contract/input.ts'
export type { ArbitrateKey, ArbitrateOutcome, DraftInput, DraftQuote, DraftReference, DraftSnapshot, ReferenceInsert, TokenSpan } from './contract/draft-editor.ts'
export type { ComposerBlock, ComposerBlocks } from './contract/composer-blocks.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scope-addressed Conversation actions and per-Session input registry. */
    conversation: import('./service.ts').IConversation
    /** Target-neutral Conversation registries and per-Session assembly. */
    uiConversation: import('./conversation/assembly.ts').UiConversation
  }
}

export type { TextInteractionDefinition, TextInteractionGesture, TextInteractionRequest, TextInteractionSurface, TextInteractionTrigger } from './contract/text-interaction.ts'
export type { ConversationInteractionRegistry } from './conversation/interaction-registry.ts'
