/** Browser Conversation assemble core, React adapter, shell, and input plugin. */
export { apply, inject } from './apply.ts'
export { UiConversation } from './conversation/assembly.ts'
export type { ConversationBinding } from './conversation/assembly.ts'
export { ConversationController, UnsupportedImageMediaTypeError } from './service.ts'
export type { IConversation } from './service.ts'
export type {
  ConversationContextReader, ConversationLocation,
  ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataSource,
  ConversationLocationDataStore,
  ConversationMatch, ConversationMatchResult, ConversationNodeContext,
  ConversationNodeDefinition, ConversationPreviousContext, ConversationPublication,
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
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  AssistantTiming, CommandNode, CompactionSummaryNode, ContextMessageNode, ConversationNode,
  ModelRetryNode, PartialAssistant, RunningToolCall, SteeringMessageNode, TodoItem,
  ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UnknownSurfaceNode,
  UserMessageNode,
} from './contract/records.ts'
export type {
  ContextProvenanceView, ContextRole, KnownContextForm,
} from './contract/context-provenance.ts'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestPromptInspection, RequestPromptInspector, RequestView,
} from './contract/request-inspection.ts'
export { inspectRequestPrompt } from './contract/request-inspection.ts'
export type { ConversationStoreState, ConversationViewRequest, ViewTab } from './contract/views.ts'

export { ConversationNodeAssembler } from './conversation/assembler.ts'
export type {
  ConversationEventDefinitions, ConversationViewDefinitions,
} from './conversation/assembler.ts'
export { ConversationDefinitionRegistry } from './conversation/definition-registry.ts'
export { ConversationEventRegistry } from './conversation/event-registry.ts'
export { ConversationLocationIndex } from './conversation/location-index.ts'
export type { ConversationLocationDataChange } from './conversation/location-index.ts'
export { ConversationViewRegistry } from './conversation/view-registry.ts'

export type { ConversationKey } from './locales.ts'
export type {
  ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps,
  ComposerBarInjected, ComposerBarOwnerProps, ComposerBarProps, ComposerChainProps,
  ConversationHeaderActionOwnerProps, ConversationHeaderLineageOwnerProps,
  ConversationInjected, ConversationSessionHeaderInjected, ConversationSessionHeaderSlotProps,
  ConversationSessionInjected, ConversationSessionSlotProps, ConversationSlotProps,
  ConversationStore, ConvViewOwnerProps, ConvViewProps, EmptyWorkspaceOwnerProps,
  HeroAgentPresetOwnerProps, HeroBrandMarkOwnerProps, InputControlOwnerProps, InputZone,
  MessageImageLoader, MessageImageSource, MessageImagesOwnerProps, RenderMessageImages, UseConversation,
  UseConversationViews,
} from './contract/slots.ts'
export type {
  ArbitrateKey, ArbitrateOutcome, BeginCommandRequest, CommandClaim, ConsumeTokenRequest,
  DraftAttachmentId, InputActions, InputState, InsertReferenceRequest, InsertTextRequest,
  PickOutcome, ReferenceInsert, SessionInput, SessionInputResolver, SubmitImageAttachment,
  SubmitOutcome, TokenSpan,
} from './contract/input.ts'
export type { ComposerBlock, ComposerBlocks } from './contract/composer-blocks.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Scope-addressed Conversation actions and per-Session input registry. */
    conversation: import('./service.ts').IConversation
    /** Target-neutral Conversation registries and per-Session assembly. */
    uiConversation: import('./conversation/assembly.ts').UiConversation
  }
}
