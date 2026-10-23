/**
 * Generate the per-subsystem Cordis service/event reference regions from the
 * Typert catalog projection. Every harness `ctx.<key>` service and event scope
 * maps to exactly one `docs/subsystems/` page through the curated tables below;
 * the generator injects each page's Cordis API reference between its GENERATED markers —
 * into both language sides of the pair, localizing paired document paths for
 * the Chinese side while retaining every other byte — and re-records a pair's
 * `.i18n.yaml` only when nothing outside the region changed. The
 * projection enforces event modes, JSDoc parameter/return completeness, and
 * signature type-link coverage; the inherited (vendor) tier renders to
 * `docs/cordis-api/inherited.md`. `--check` verifies every generated artifact.
 *
 * Generated regions embed `file:line` source pointers, so inserting lines ABOVE a
 * recorded symbol makes the committed output stale even though nothing about the
 * symbol changed. Regenerate after editing any file this projection records — the
 * failure otherwise surfaces as the "reproduces every committed catalog artifact
 * byte for byte" test failing, which reads like a snapshot regression rather than
 * a missing regeneration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  projectCordisCatalog,
  renderInheritedPage,
  renderPageRegion,
  REGION_BEGIN,
  REGION_END,
} from '@deepseek-ai/dsh-typert-generator'
import type { CordisCatalogPolicy } from '@deepseek-ai/dsh-typert-generator'
import { renderCordisCoreApiPages } from './cordis-core-api.ts'
import { contextKeyMap, contextMergeFiles, eventNameList } from './cordis-walk.ts'
import {
  parseTranslationPairingManifest,
  translationPairSourcePredicate,
} from './translation-pairing.ts'
import { rewriteTranslationLinkLocales } from './translation-links.ts'

const root = resolve(import.meta.dirname, '..')
const SUBSYSTEMS_DIR = 'docs/subsystems'
const OUT_INHERITED = 'docs/cordis-api/inherited.md'
const OUT_RUNTIME_API = 'packages/extensions/tool-cordis/src/api-catalog.ts'

export { REGION_BEGIN, REGION_END }

/**
 * The owning subsystems page for every harness `ctx.<key>` service the
 * projection discovers. Fail-closed both ways: a discovered key absent here
 * and an entry whose key the projection no longer discovers are both hard
 * errors, so the partition can never silently drift from the service API.
 */
export const SERVICE_PAGE: Record<string, string> = {
  headlessStartup: 'boot.md',
  translator: 'translation.md',
  cotTranslation: 'translation.md',
  speechToText: 'voice-input.md',
  speechController: 'voice-input.md',
  otel: 'otel.md',
  productTelemetry: 'product-telemetry.md',
  productAnalytics: 'product-telemetry.md',
  connection: 'web-server.md',
  pluginManager: 'boot.md',
  actionCards: 'boot.md',
  pluginRecommendations: 'boot.md',
  pluginMarket: 'boot.md',
  pluginRegistryProbe: 'boot.md',
  configEditor: 'boot.md',
  profileContext: 'boot.md',
  hmr: 'boot.md',
  mcpResources: 'mcp.md',
  agentLoop: 'core.md',
  agentDefaultModel: 'core.md',
  agentPresets: 'core.md',
  agents: 'core.md',
  approval: 'approval.md',
  officeToPdf: 'office-to-pdf.md',
  attachments: 'attachment.md',
  shell: 'shell.md',
  shellEnv: 'shell.md',
  clientModules: 'client-modules.md',
  ptcRuntime: 'ptc-runtime.md',
  browserUse: 'browser-use.md',
  computerUse: 'computer-use.md',
  cuaAccess: 'computer-use.md',
  commands: 'commands.md',
  compaction: 'compaction.md',
  cordisInspect: 'extensions.md',
  authorization: 'credentials.md',
  deepseekAccount: 'credentials.md',
  credentials: 'credentials.md',
  credentialsController: 'credentials.md',
  settingsController: 'settings.md',
  directoryPicker: 'workspace.md',
  deepseekLlmApiExtensions: 'llm-streaming.md',
  dynamicCordisRunner: 'extensions.md',
  fileUploads: 'attachment.md',
  fileReferences: 'session-reference.md',
  fs: 'filesystem.md',
  goals: 'goal.md',
  schedule: 'schedule.md',
  inspector: 'extensions.md',
  webServer: 'web-server.md',
  webApp: 'web-server.md',
  llm: 'llm-streaming.md',
  lsp: 'lsp.md',
  messageFeedback: 'feedback.md',
  sessionFeedback: 'feedback.md',
  permissionPresets: 'permission-presets.md',
  planMode: 'plan.md',
  terminals: 'terminal.md',
  sandbox: 'sandbox.md',
  sandboxPolicy: 'sandbox.md',
  ssh: 'ssh.md',
  sessionPersistence: 'persistence.md',
  sessionQuery: 'session-query.md',
  sessionFileReferences: 'session-reference.md',
  sessionReferenceResolver: 'session-reference.md',
  sessionProjectionCache: 'session-projection.md',
  sessionProjections: 'session-projection.md',
  workingDirectory: 'working-directory.md',
  worktrees: 'worktrees.md',
  sessionController: 'session.md',
  sessionSkillCatalog: 'skills.md',
  sessions: 'session.md',
  settings: 'settings.md',
  sessionTitle: 'session-title.md',
  skills: 'skills.md',
  spillStore: 'spill.md',
  storage: 'storage.md',
  storageDomain: 'storage.md',
  subagentModelSelection: 'subagent.md',
  subagents: 'subagent.md',
  subprocess: 'subprocess.md',
  systemPrompt: 'system-prompt.md',
  jobs: 'jobs.md',
  jobController: 'jobs.md',
  sessionTelemetry: 'session-telemetry.md',
  agentTeams: 'agent-team.md',
  claudeCodeMods: 'claude-code-mods.md',
  tokenMeter: 'token-meter.md',
  toolResultPruner: 'compaction.md',
  tools: 'tools.md',
  typert: 'typert.md',
  typertGateway: 'typert.md',
  remoteAccess: 'typert.md',
  userQuestions: 'user-questions.md',
  web: 'web.md',
  workflowEngine: 'workflow.md',
  webhookRuntime: 'webhook.md',
  workspaceRegistry: 'workspace.md',
  workspaceController: 'workspace.md',
  workspaceFiles: 'workspace.md',
  workspaceChanges: 'deliverables.md',
  terminalController: 'workspace.md',
  directoryPickerController: 'workspace.md',
}

/**
 * Context keys declared in `interface Context` merges that the rendering
 * projection cannot see, each with the reason and its documentation owner.
 * The scan that enforces this list reads EVERY `declare module '@deepseek-ai/cordis'`
 * Context merge under `packages/x/x/src/**` — any depth, not only root
 * `index.ts` files with a same-named service class — so a new service can
 * never silently join this blind spot: it either enters {@link SERVICE_PAGE}
 * or names itself here. Client-face keys (the projection analyzes the host
 * face only) name the package README that owns their surface.
 *
 * Two categories remain, and neither is a projection gap a scanning rule could
 * close. An OPTIONAL key (`key?: X`) is a value the launcher or boot code
 * installs before the tree mounts, which the analyzer skips by rule because no
 * plugin provides it and `inject` cannot reach it. A client-face key belongs to
 * the browser Context, which this host-face program never sees; the browser
 * surface has its own generated catalog (`scripts/gen-client-catalog.ts`, served
 * to a model as `cordis_runtime_inspect what:"client"`).
 */
export const SERVICE_WALK_EXEMPTIONS: Record<string, string> = {
  invocation: 'not a service: per-call accessor (RemoteInvocation | undefined) the Gateway derives for each Remote call — packages/api/gateway/README.md owns the contract',
  webTerminals: 'client-side terminal view models — packages/api/terminal-controller/README.md owns the API',
  appReady: 'not a service: launcher-provided successful-startup signal — packages/boot/cmdline/README.md owns the launcher contract',
  appExit: 'not a service: launcher-provided bounded process-exit callback — packages/boot/cmdline/README.md owns the launcher contract',
  cmdlineArgs: 'not a service: launcher-provided immutable app argument accessor — packages/boot/cmdline/README.md owns the launcher contract',
  configuredAgentIdentities: 'not a service: launcher-provided boot-context value (ConfiguredAgentIdentities | undefined) — packages/core/agent-loop/README.md owns this launcher contract',
  launcherSessionQueryPath: 'not a service: launcher-provided boot-context value (string | undefined) — packages/session-query/session-query-sqlite/README.md owns this launcher contract',
  dshHomePath: 'not a service: boot-provided root accessor function (typeof dshHomePath | undefined) for Loader !!js config expressions — packages/boot/app-boot/README.md owns the boot contract',
  launchEnvironment: 'not a service: launcher-provided root accessor value (LaunchEnvironmentSnapshot | undefined) — packages/util/launch-environment/README.md owns this launcher contract',
  pluginPackages: 'profile-boot-owned package resolver service used by optional consumers — packages/boot/app-boot/README.md owns this internal API',
  fileUpload: 'client-side browser upload service — packages/client/file-upload/README.md owns the API',
  uiRenderer: 'client-side interface-typed browser service — packages/client/ui-renderer/README.md owns the API',
  uiSession: 'client-side Session source adapter — packages/client/ui-session/README.md owns the API',
  uiConversation: 'client-side Conversation registries and assembler — packages/client/ui-conversation/README.md owns the API',
  uiWorkspace: 'client-side Workspace navigation adapter — packages/client/ui-workspace/README.md owns the API',
  settingsSchema: 'client-side schema introspection service — packages/client/ui-settings/README.md owns the API',
  configForms: 'client-side shared entry forms — packages/client/ui-settings/README.md owns the API',
  chatFileMentions: 'client-side slot-contract accessor (ChatFileMentions) — packages/client/ui-chat/README.md owns the API',
  shortcuts: 'client-side interface-typed keyboard service — packages/client/shortcuts/README.md owns the API',
  userQuestionPanels: 'client-side slot-contract accessor (UserQuestionPanels) — packages/client/ui-tool/README.md owns the API',
  commandUi: 'client-side interface-typed browser service — packages/client/ui-commands/README.md owns the API',
  fileDrag: 'client-side file preparation and transfer service — packages/client/ui-file-drag/README.md owns the API',
  feedbackUi: 'client-side feedback dialog service — packages/client/ui-message-feedback/README.md owns the API',
  conversation: 'client-side interface-typed browser service — packages/client/ui-conversation/README.md owns the API',
  layout: 'client-side interface-typed browser service — packages/client/ui-layout/README.md owns the API',
  pluginNavigation: 'client-side bundle navigation — packages/client/ui-plugin-manager/README.md owns the API',
  pluginChanges: 'client-side read-only management activity — packages/client/ui-plugin-manager/README.md owns the API',
  locale: 'client-side interface-typed browser service — packages/client/locale/README.md owns the API',
  modelDirectories: 'client-side interface-typed browser service — packages/client/ui-model-selection/README.md owns the API',
  modules: 'client-side interface-typed browser service — packages/client/modules/README.md owns the API',
  remote: 'client-side interface-typed gateway accessor (ClientRemote) — packages/api/gateway/README.md owns the API',
  sessionLogDownload: 'client-side browser download controller — packages/session-query/session-log-export/README.md owns the API',
  inputTriggers: 'client-side interface-typed browser service — packages/client/ui-input-trigger/README.md owns the API',
  slots: 'client-side interface-typed browser service — packages/client/ui-renderer/README.md owns the API',
  theme: 'client-side interface-typed browser service — packages/client/ui-theme/README.md owns the API',
  workspaces: 'client-side interface-typed browser service — packages/api/workspace-controller/README.md owns the API',
  resources: 'client-side resource model (protocol providers, pins, live sources) — packages/client/resources/README.md owns the API',
  sidebarRight: 'client-side right-Sidebar navigation face — packages/client/ui-sidebar-right/README.md owns the API',
  sidebarRightTabs: 'client-side right-Sidebar tab-type registry — packages/client/ui-sidebar-right/README.md owns the API',
  documentPreviews: 'client-side document renderer registry — docs/subsystems/sidebar-right.md owns the API',
}

/**
 * The owning subsystems page for every harness event scope (the segment
 * before the first `/`) the projection renders. Fail-closed exactly like
 * {@link SERVICE_PAGE}. Client-face events (`slash/*`, `theme/change`, …) are
 * invisible to the host-face projection and therefore never reach this map;
 * {@link EVENT_WALK_EXEMPTIONS} names each one with its documentation owner.
 */
export const EVENT_SCOPE_PAGE: Record<string, string> = {
  'app-boot': 'boot.md',
  hmr: 'boot.md',
  'plugin-manager': 'boot.md',
  'plugin-market': 'boot.md',
  'agent': 'core.md',
  'agent-loop': 'core.md',
  'agent-preset': 'core.md',
  'api-session': 'session.md',
  'approval': 'approval.md',
  'commands': 'commands.md',
  'connection': 'web-server.md',
  'compaction': 'compaction.md',
  'cordis': 'extensions.md',
  'authorization': 'credentials.md',
  'credentials': 'credentials.md',
  'deepseek-account': 'credentials.md',
  'domain': 'storage.md',
  'fs': 'filesystem.md',
  'goal': 'goal.md',
  'schedule': 'schedule.md',
  'llm': 'llm-streaming.md',
  'permission-presets': 'permission-presets.md',
  'session': 'session.md',
  'settings': 'settings.md',
  'skills': 'skills.md',
  'subagent': 'subagent.md',
  'system-prompt': 'system-prompt.md',
  'session-telemetry': 'session-telemetry.md',
  'feedback': 'feedback.md',
  'tools': 'tools.md',
  'user-questions': 'user-questions.md',
  'webserver': 'web-server.md',
  'workflow': 'workflow.md',
  'workspace': 'workspace.md',
}

/**
 * Event names declared in `interface Events` merges that the rendering
 * projection cannot see, each with the reason and its documentation owner.
 * The mirror of {@link SERVICE_WALK_EXEMPTIONS} for events: an independent
 * scan reads EVERY `declare module '@deepseek-ai/cordis'` Events merge under
 * `packages/x/x/src/**`, so a declared event either renders onto a subsystems
 * page (via {@link EVENT_SCOPE_PAGE}) or names itself here — never vanishes
 * silently. Keys are full event names rather than scopes, so a scope-level
 * exemption cannot mask another declaration in that scope.
 */
export const EVENT_WALK_EXEMPTIONS: Record<string, string> = {
  'agent/request': 'deprecated compatibility hook — packages/core/agent/README.md documents migration',
  'command/executed': 'client-face local command acknowledgment — packages/client/ui-commands/README.md owns the API',
  'connection/reset': 'client-face transport signal — packages/api/session-controller/README.md owns the API',
  'locale/change': 'client-face locale switch signal — packages/client/locale/README.md owns the API',
  'slash/input-begin-command': 'client-face slash-input protocol — packages/client/ui-input-trigger/README.md owns the API',
  'slash/input-consume-token': 'client-face slash-input protocol — packages/client/ui-input-trigger/README.md owns the API',
  'slash/input-insert-reference': 'client-face slash-input protocol — packages/client/ui-input-trigger/README.md owns the API',
  'slash/input-insert-text': 'client-face slash-input protocol — packages/client/ui-input-trigger/README.md owns the API',
  'slots/changed': 'client-face slot invalidation signal — packages/client/ui-renderer/README.md owns the API',
  'theme/change': 'client-face theme switch signal — packages/client/ui-theme/README.md owns the API',
}

/**
 * One primary subsystems page per project type used by a generated
 * signature. This stays curated because union names intentionally do not
 * reuse the type-equivalence manifest's map-symbol entries and some symbols
 * appear on more than one page.
 */
export const LINK_MAP: Readonly<Record<string, string>> = {
  Principal: 'typert.md',
  PrincipalMap: 'typert.md',
  RemoteAccessResource: 'typert.md',
  RemoteAccessResourceKind: 'typert.md',
  RemoteStream: 'typert.md',
  RemoteUplinkWindow: 'typert.md',
  EventLogOptions: 'otel.md',
  EventLogReporter: 'otel.md',
  SessionLogOptions: 'otel.md',
  SessionLogReporter: 'otel.md',
  OTelEventRecord: 'otel.md',
  OTelEventScalar: 'otel.md',
  ProductTelemetryRecord: 'product-telemetry.md',
  ProductTelemetryScalar: 'product-telemetry.md',
  WorkspaceChangesSummary: 'deliverables.md',
  WorkspaceFileDiff: 'deliverables.md',
  Reload: 'boot.md',
  ProfileReconciliation: 'boot.md',
  PluginInfo: 'boot.md',
  BundleInfo: 'boot.md',
  MarketIndexSummary: 'boot.md',
  MarketListingEntry: 'boot.md',
  MarketQuery: 'boot.md',
  MarketSearchResult: 'boot.md',
  MarketSort: 'boot.md',
  PluginDetail: 'boot.md',
  BundleDetail: 'boot.md',
  NpmFileSource: 'boot.md',
  ChangeResult: 'boot.md',
  InstallBundleOptions: 'boot.md',
  PluginEntryId: 'boot.md',
  BundleRowInfo: 'boot.md',
  PluginInstallCancellation: 'boot.md',
  PluginInstallRequestId: 'boot.md',
  PluginSpecInspection: 'boot.md',
  PluginChange: 'boot.md',
  PluginInstallLogChunk: 'boot.md',
  PluginInstallProgress: 'boot.md',
  PluginUpdateProgress: 'boot.md',
  PluginUpdateResult: 'boot.md',
  PluginVersionList: 'boot.md',
  ListVersionsOptions: 'boot.md',
  UpdateBundleOptions: 'boot.md',
  PluginRegistries: 'boot.md',
  InspectOptions: 'boot.md',
  BrowserUseProviderName: 'browser-use.md',
  ComputerUseProviderName: 'computer-use.md',
  CuaApplicationId: 'computer-use.md',
  CuaApplicationGrant: 'computer-use.md',
  CuaPermissionProcess: 'computer-use.md',
  CuaApplicationState: 'computer-use.md',
  CuaSystemPermission: 'computer-use.md',
  CuaSystemPermissionState: 'computer-use.md',
  RenderedDocumentBytes: 'office-to-pdf.md',
  OfficeToPdfRequest: 'office-to-pdf.md',
  OfficeToPdfResult: 'office-to-pdf.md',
  OfficeToPdfPriority: 'office-to-pdf.md',
  OfficeToPdfGeneration: 'office-to-pdf.md',
  Agent: 'core.md',
  AgentCancelCause: 'core.md',
  AgentFactory: 'core.md',
  AgentHandle: 'core.md',
  ModelSelection: 'core.md',
  AllowedModelRoute: 'subagent.md',
  SubagentModelSelectionSettings: 'subagent.md',
  AgentOptions: 'core.md',
  TurnBoundaryProjection: 'core.md',
  AgentStatus: 'core.md',
  AssistantStreamFrame: 'core.md',
  ContentBlock: 'llm-streaming.md',
  CreateAgentOptions: 'core.md',
  CreateWorktreeRequest: 'worktrees.md',
  CreatedWorktree: 'worktrees.md',
  GenerateOptions: 'llm-streaming.md',
  Inbox: 'core.md',
  InboxItem: 'core.md',
  InboxPlacement: 'core.md',
  InspectorJsonValue: 'extensions.md',
  MessageId: 'llm-streaming.md',
  ResumeAgentOptions: 'core.md',
  SettleReason: 'core.md',
  AdapterRegistrationHandle: 'llm-streaming.md',
  DirectoryRegistrationHandle: 'llm-streaming.md',
  DeepSeekLlmApiExtensionMap: 'llm-streaming.md',
  DeepSeekLlmApiExtensionProvider: 'llm-streaming.md',
  DeepSeekLlmApiExtensionRequest: 'llm-streaming.md',
  LlmCallConfig: 'llm-streaming.md',
  ConfigureCall: 'llm-streaming.md',
  LlmModelContext: 'llm-streaming.md',
  LlmModelReasoningInfo: 'llm-streaming.md',
  LlmResolvedModelInfo: 'llm-streaming.md',
  LlmFailure: 'llm-streaming.md',
  LlmImageRequestPricing: 'llm-streaming.md',
  LlmModelInfo: 'llm-streaming.md',
  LlmProviderInfo: 'llm-streaming.md',
  LlmConfigurableProvider: 'llm-streaming.md',
  LlmNativeAuth: 'llm-streaming.md',
  LlmModelDiscoveryRequest: 'llm-streaming.md',
  LlmDiscoveredModel: 'llm-streaming.md',
  ResolvedRetryPolicy: 'llm-streaming.md',
  Message: 'llm-streaming.md',
  MessageSource: 'llm-streaming.md',
  MessageFeedbackDeleteRequest: 'feedback.md',
  MessageFeedbackDeleteResult: 'feedback.md',
  MessageFeedbackDeleteValue: 'feedback.md',
  MessageFeedbackFailure: 'feedback.md',
  MessageFeedbackItem: 'feedback.md',
  MessageFeedbackListRequest: 'feedback.md',
  SessionFeedbackRecordRequest: 'feedback.md',
  SessionFeedbackRecordResult: 'feedback.md',
  MessageFeedbackListResult: 'feedback.md',
  MessageFeedbackListValue: 'feedback.md',
  MessageFeedbackNoteBlank: 'feedback.md',
  MessageFeedbackNoteTooLarge: 'feedback.md',
  MessageFeedbackPutRequest: 'feedback.md',
  MessageFeedbackPutResult: 'feedback.md',
  MessageFeedbackRating: 'feedback.md',
  MessageFeedbackRejected: 'feedback.md',
  MessageFeedbackSessionNotFound: 'feedback.md',
  MessageFeedbackSuccess: 'feedback.md',
  MessageFeedbackTargetNotFound: 'feedback.md',
  MessageFeedbackVersion: 'feedback.md',
  MessageFeedbackVersionConflict: 'feedback.md',
  UserMessage: 'session.md',
  ApiSessionAgentResult: 'session.md',
  PreStepDecision: 'core.md',
  PreStepContext: 'core.md',
  RequestErrorAction: 'core.md',
  RequestFailureContext: 'core.md',
  PreparedReferencedMessage: 'session-reference.md',
  FileReferenceCandidate: 'session-reference.md',
  SessionReferenceCandidate: 'session-reference.md',
  SessionReferenceMentionCandidate: 'session-reference.md',
  SessionReferenceInput: 'session-reference.md',
  SessionAttachmentRequest: 'session.md',
  SessionAttachmentValue: 'session.md',
  SessionCancelRequest: 'session.md',
  SessionCancelValue: 'session.md',
  SessionControlFrame: 'session.md',
  SessionCreateRequest: 'session.md',
  SessionCreateValue: 'session.md',
  SessionEvent: 'session.md',
  SessionFollowFrame: 'session.md',
  SessionFollowRequest: 'session.md',
  SessionForkRequest: 'session.md',
  SessionForkValue: 'session.md',
  SessionId: 'core.md',
  SessionLogOffset: 'session.md',
  SessionSeq: 'session.md',
  SessionSeqCursor: 'session.md',
  OptionalSessionSeq: 'session.md',
  SessionListRequest: 'session.md',
  SessionListValue: 'session.md',
  ModelCatalog: 'session.md',
  SessionOpenWorkspacePathRequest: 'session.md',
  SessionOpenWorkspacePathValue: 'session.md',
  SessionWorkspacePathApplication: 'session.md',
  SessionModels: 'session.md',
  SessionModelsRequest: 'session.md',
  SessionPage: 'session.md',
  SessionPageRequest: 'session.md',
  SessionPromptRequest: 'session.md',
  SessionPromptValue: 'session.md',
  SessionRenameRequest: 'session.md',
  SessionRenameValue: 'session.md',
  SessionRespondReceipt: 'session.md',
  SessionRespondRequest: 'session.md',
  SessionSearchValue: 'session.md',
  SessionSelectModelRequest: 'session.md',
  SessionSelectModelValue: 'session.md',
  SessionSummary: 'session.md',
  SessionMessageProjection: 'session.md',
  SessionUpdateQueueRequest: 'session.md',
  SessionUpdateQueueValue: 'session.md',
  EncodedFileUploadRequest: 'attachment.md',
  AgentResolver: 'attachment.md',
  PromptFileBinding: 'attachment.md',
  FileUploadReceiptId: 'attachment.md',
  FileUploadValue: 'attachment.md',
  ImageUploadValue: 'attachment.md',
  StagedAttachment: 'attachment.md',
  SessionStartSource: 'core.md',
  ToolCallId: 'core.md',
  SessionLogSnapshot: 'session-query.md',
  SessionSurfaceSnapshot: 'session-query.md',
  ApprovalOutcome: 'approval.md',
  ApprovalPolicy: 'approval.md',
  ApprovalRequest: 'approval.md',
  ApprovalRequestEvent: 'approval.md',
  ApprovalService: 'approval.md',
  AskUserQuestionRequestEvent: 'user-questions.md',
  AdmittedPromptContentPart: 'attachment.md',
  AttachmentAdmissionPart: 'attachment.md',
  AttachmentError: 'attachment.md',
  EncodedFileAttachment: 'attachment.md',
  EncodedImageAttachment: 'attachment.md',
  FileAttachmentRef: 'attachment.md',
  SaveFileAttachment: 'attachment.md',
  SaveFileStreamAttachment: 'attachment.md',
  ImageAttachmentAccess: 'llm-streaming.md',
  ImageAttachmentRef: 'attachment.md',
  ImageRequestTarget: 'attachment.md',
  ProjectedDimensions: 'attachment.md',
  PromptContentPart: 'attachment.md',
  RequestImageAttachment: 'attachment.md',
  SaveImageAttachment: 'attachment.md',
  StoredImageAttachment: 'attachment.md',
  ShellExecRequest: 'shell.md',
  ShellExecSpec: 'shell.md',
  ShellExecution: 'shell.md',
  ShellProcess: 'shell.md',
  ShellPromotionOffer: 'shell.md',
  ShellRunResult: 'shell.md',
  DshEnvironment: 'subprocess.md',
  SubprocessHandle: 'subprocess.md',
  SubprocessOutcome: 'subprocess.md',
  SubprocessOutputRead: 'subprocess.md',
  SubprocessOutputReader: 'subprocess.md',
  SubprocessSpawnSpec: 'subprocess.md',
  SubprocessTerminalHandle: 'subprocess.md',
  SubprocessTerminalEnvironment: 'subprocess.md',
  SubprocessTerminalSpawnSpec: 'subprocess.md',
  PtcRunRequest: 'ptc-runtime.md',
  PtcRunSpec: 'ptc-runtime.md',
  PtcRunSandbox: 'ptc-runtime.md',
  PtcRunResult: 'ptc-runtime.md',
  CompactionResult: 'compaction.md',
  CompactionTrigger: 'compaction.md',
  PruneResult: 'compaction.md',
  FileReadOutcome: 'filesystem.md',
  FsDirEntry: 'filesystem.md',
  FsEditOutcome: 'filesystem.md',
  FsEditRequest: 'filesystem.md',
  FsInfo: 'filesystem.md',
  FsObservation: 'filesystem.md',
  FsPathInfo: 'filesystem.md',
  FsObservationActor: 'filesystem.md',
  FsTarget: 'filesystem.md',
  FsVersion: 'filesystem.md',
  FsWriteIntent: 'filesystem.md',
  FsWriteOutcome: 'filesystem.md',
  CreateGoalRequest: 'goal.md',
  EditGoalRequest: 'goal.md',
  GoalBlockReason: 'goal.md',
  GoalActivationChanged: 'goal.md',
  GoalChanged: 'goal.md',
  GoalRef: 'goal.md',
  GoalView: 'goal.md',
  ScheduleCatalogEntry: 'schedule.md',
  ScheduleDeliveryReceipt: 'schedule.md',
  ScheduleDeliveryRecord: 'schedule.md',
  ScheduleDeliveryHistoryRequest: 'schedule.md',
  ScheduleDeliveryHistoryResult: 'schedule.md',
  ScheduleCreateRequest: 'schedule.md',
  ScheduleListRequest: 'schedule.md',
  ScheduleDeleteRequest: 'schedule.md',
  ScheduleDeleteResult: 'schedule.md',
  ScheduleDeleteInactiveResult: 'schedule.md',
  ScheduleTimingChange: 'schedule.md',
  ScheduleUpdateRequest: 'schedule.md',
  ScheduleUpdateResult: 'schedule.md',
  ScheduleRecord: 'schedule.md',
  DailyInput: 'schedule.md',
  DailyScheduleRecord: 'schedule.md',
  RecurringScheduleRecord: 'schedule.md',
  LegacyScheduleRecord: 'schedule.md',
  CreateGoalResult: 'goal.md',
  CommandDefinition: 'commands.md',
  CommandDescriptor: 'commands.md',
  CommandFileReceiptResolver: 'commands.md',
  CommandId: 'commands.md',
  CommandResult: 'commands.md',
  CommandSubmitAttachment: 'commands.md',
  CommandSurface: 'commands.md',
  LspProvider: 'lsp.md',
  LspQueryRequest: 'lsp.md',
  LspQueryResult: 'lsp.md',
  LlmAdapter: 'llm-streaming.md',
  PreparedLlmCall: 'llm-streaming.md',
  PreparedDeepSeekLlmApiExtensions: 'llm-streaming.md',
  LlmRuntime: 'llm-streaming.md',
  StreamChunk: 'llm-streaming.md',
  SkillProviderControl: 'skills.md',
  CreateSessionOptions: 'persistence.md',
  PrepareSessionOptions: 'persistence.md',
  SessionHeader: 'persistence.md',
  SessionLocation: 'persistence.md',
  SessionPreparation: 'persistence.md',
  SessionAccess: 'persistence.md',
  SessionHandle: 'persistence.md',
  SessionPersistenceCreateOptions: 'persistence.md',
  SessionPersistenceOpenOptions: 'persistence.md',
  SessionPersistenceStatOptions: 'persistence.md',
  SessionPersistenceListOptions: 'persistence.md',
  SessionPersistenceSnapshot: 'persistence.md',
  SessionInspection: 'persistence.md',
  SessionStorageMetadata: 'persistence.md',
  ConfinedArgv: 'sandbox.md',
  SandboxExecutionPolicy: 'sandbox.md',
  SandboxMode: 'sandbox.md',
  SandboxPolicy: 'sandbox.md',
  TerminalBackend: 'terminal.md',
  TerminalReadRequest: 'terminal.md',
  TerminalReadResult: 'terminal.md',
  TerminalSendOperation: 'terminal.md',
  TerminalSendRequest: 'terminal.md',
  TerminalSessionId: 'terminal.md',
  TerminalSessionSnapshot: 'terminal.md',
  TerminalSignal: 'terminal.md',
  TerminalSignalResult: 'terminal.md',
  TerminalSpawnRequest: 'terminal.md',
  TerminalSpawnResult: 'terminal.md',
  SandboxPolicyRequest: 'sandbox.md',
  SshConnection: 'ssh.md',
  SshStreamEndpoint: 'ssh.md',
  ScopeKey: 'scope.md',
  Scoped: 'scope.md',
  EpochHeader: 'session.md',
  Session: 'session.md',
  SessionEventMap: 'session.md',
  TurnEndReason: 'session.md',
  TurnTrigger: 'session.md',
  SessionEventReadRequest: 'session-query.md',
  SessionEventRecord: 'session-query.md',
  SessionEventResultFilter: 'session-query.md',
  SessionEventSearchDocument: 'session-query.md',
  SessionEventSearchHit: 'session-query.md',
  SessionEventSearchPage: 'session-query.md',
  SessionEventSearchRequest: 'session-query.md',
  SessionEventTrace: 'session-query.md',
  SessionEventTraceObservation: 'session-query.md',
  SessionEventTraceRequest: 'session-query.md',
  SessionEventWindow: 'session-query.md',
  SessionLineageTrace: 'session-query.md',
  SessionObservation: 'session-query.md',
  SessionObservationOptions: 'session-query.md',
  SessionRecord: 'session-query.md',
  SessionResultFilter: 'session-query.md',
  SessionSearchExecContext: 'session-query.md',
  SessionSearchHit: 'session-query.md',
  SessionSearchPage: 'session-query.md',
  SessionSearchRequest: 'session-query.md',
  SessionTitleObservation: 'session-query.md',
  SessionTitleObservationResult: 'session-query.md',
  SessionTitleProvider: 'session-title.md',
  SessionTitleSnapshot: 'session-title.md',
  SkillCatalogSnapshot: 'skills.md',
  SkillDefinition: 'skills.md',
  SkillLookupOptions: 'skills.md',
  SkillProvider: 'skills.md',
  SkillProviderObservation: 'skills.md',
  SkillRegistration: 'skills.md',
  SkillViewOptions: 'skills.md',
  SkillSummary: 'skills.md',
  SaveTextSpill: 'spill.md',
  SpillRef: 'spill.md',
  ContinuableCreateRequest: 'subagent.md',
  ContinuableCreateSpec: 'subagent.md',
  SubagentActivation: 'subagent.md',
  SubagentActivationSpec: 'subagent.md',
  AgentMessageSource: 'subagent.md',
  SubagentCatalogEntry: 'subagent.md',
  SubagentCatalogState: 'subagent.md',
  SessionProjectionsRequest: 'session.md',
  SessionProjectionsValue: 'session.md',
  SubagentDescendantListEntry: 'subagent.md',
  SubagentSendMessageOptions: 'subagent.md',
  SubagentInterruptAuthority: 'subagent.md',
  SubagentInterruptReceipt: 'subagent.md',
  SubagentListEntry: 'subagent.md',
  SubagentPromptReceipt: 'subagent.md',
  SubagentPromptRequest: 'subagent.md',
  SubagentProvider: 'subagent.md',
  SubagentRun: 'subagent.md',
  SubagentRuntime: 'subagent.md',
  SubagentStartRequest: 'subagent.md',
  AssembleContext: 'system-prompt.md',
  PromptContext: 'system-prompt.md',
  PromptContextOrderName: 'system-prompt.md',
  PromptSection: 'system-prompt.md',
  PromptSectionOrderName: 'system-prompt.md',
  SystemPrompt: 'system-prompt.md',
  ToolProviderResult: 'system-prompt.md',
  JobId: 'jobs.md',
  JobKillRequest: 'jobs.md',
  JobKillValue: 'jobs.md',
  JobFollowFrame: 'jobs.md',
  JobFollowRequest: 'jobs.md',
  JobListFrame: 'jobs.md',
  JobListRequest: 'jobs.md',
  JobRead: 'jobs.md',
  JobView: 'jobs.md',
  JobChunk: 'jobs.md',
  JobSpec: 'jobs.md',
  JobHandle: 'jobs.md',
  JobHooks: 'jobs.md',
  JobOutcome: 'jobs.md',
  JobOutputSource: 'jobs.md',
  JobSourceRead: 'jobs.md',
  JobOutputRead: 'jobs.md',
  JobAppendOptions: 'jobs.md',
  JobChannel: 'jobs.md',
  JobEvent: 'jobs.md',
  JobEventFilter: 'jobs.md',
  JobEventListener: 'jobs.md',
  JobEvents: 'jobs.md',
  JobSettleCause: 'jobs.md',
  SpeechDownloadFailure: 'voice-input.md',
  SpeechPreparationState: 'voice-input.md',
  SpeechPreparationOptions: 'voice-input.md',
  SpeechPreparationStep: 'voice-input.md',
  SpeechPreparationStepKind: 'voice-input.md',
  SpeechProviderView: 'voice-input.md',
  SpeechSetupEstimate: 'voice-input.md',
  SpeechSelection: 'voice-input.md',
  SpeechSelectionPatch: 'voice-input.md',
  SpeechSnapshot: 'voice-input.md',
  SpeechPreparation: 'voice-input.md',
  SpeechProvider: 'voice-input.md',
  SpeechProviderId: 'voice-input.md',
  SpeechProviderInfo: 'voice-input.md',
  SpeechInput: 'voice-input.md',
  SpeechRequest: 'voice-input.md',
  TranslationProvider: 'translation.md',
  TranslationRequest: 'translation.md',
  TranslationSpec: 'translation.md',
  CotTranslationPreferences: 'translation.md',
  CotTranslationSnapshot: 'translation.md',
  TranslationError: 'translation.md',
  TranslationErrorCode: 'translation.md',
  SpeechSpec: 'voice-input.md',
  Transcript: 'voice-input.md',
  SpeechCatalog: 'voice-input.md',
  TranscriptionRequest: 'voice-input.md',
  CreateTeamTaskRequest: 'agent-team.md',
  SendTeamMessageRequest: 'agent-team.md',
  SendTeamMessageResult: 'agent-team.md',
  SpawnTeammateRequest: 'agent-team.md',
  SpawnTeammateResult: 'agent-team.md',
  TeamId: 'agent-team.md',
  TeamMemberView: 'agent-team.md',
  TeamMembership: 'agent-team.md',
  TeamTaskId: 'agent-team.md',
  TeamTaskView: 'agent-team.md',
  TeamProjection: 'agent-team.md',
  TeamMemberProjection: 'agent-team.md',
  TeamWaitResult: 'agent-team.md',
  UpdateTeamTaskRequest: 'agent-team.md',
  ModDefinition: 'claude-code-mods.md',
  SurfaceSnapshot: 'claude-code-mods.md',
  TokenMeasurement: 'token-meter.md',
  ContextPressureProjection: 'token-meter.md',
  PtcDispatchLog: 'tools.md',
  PostToolDecision: 'tools.md',
  PreToolDecision: 'tools.md',
  ToolDefinition: 'tools.md',
  ToolExecution: 'tools.md',
  ToolDispatchExecution: 'tools.md',
  ToolExecutionInput: 'tools.md',
  ToolExecutionMode: 'tools.md',
  ToolExecutionResult: 'tools.md',
  ToolExecutionToken: 'tools.md',
  ToolGuard: 'tools.md',
  ToolRuntime: 'tools.md',
  ToolsService: 'tools.md',
  ToolExecutor: 'tools.md',
  ToolModelInput: 'tools.md',
  ToolPromptSection: 'tools.md',
  ToolBatchInput: 'tools.md',
  ToolCallResult: 'tools.md',
  ToolBatchResult: 'tools.md',
  ToolRestriction: 'tools.md',
  ToolActivationContext: 'tools.md',
  ToolRegistrationOptions: 'tools.md',
  ResolvedToolSet: 'tools.md',
  ToolSchema: 'tools.md',
  SettingsNamespace: 'settings.md',
  SettingsDescriptor: 'settings.md',
  SettingsDescribeValue: 'settings.md',
  SettingsDocumentOpenValue: 'settings.md',
  AgentPresetDirectoryOpenValue: 'settings.md',
  SettingsNamespaceView: 'settings.md',
  SettingsPathOpView: 'settings.md',
  SettingsSecretView: 'settings.md',
  SettingsPathOp: 'settings.md',
  SettingsDescribeOptions: 'settings.md',
  SkillListRequest: 'skills.md',
  SkillListValue: 'skills.md',
  AuthorizationEntry: 'credentials.md',
  AuthorizationFlow: 'credentials.md',
  AuthorizationInteraction: 'credentials.md',
  AuthorizationMethod: 'credentials.md',
  AuthorizationNotice: 'credentials.md',
  AuthorizationOutcome: 'credentials.md',
  AccountView: 'credentials.md',
  AccountDetails: 'credentials.md',
  AccountClientMetadata: 'credentials.md',
  AccountBonusBatch: 'credentials.md',
  AccountBonusOrderId: 'credentials.md',
  AccountUserId: 'credentials.md',
  PlatformSession: 'credentials.md',
  SignInAttemptId: 'credentials.md',
  AuthorizationPrompt: 'credentials.md',
  AuthorizationRequest: 'credentials.md',
  AuthorizationSession: 'credentials.md',
  AuthorizationSettlement: 'credentials.md',
  AuthorizationStatus: 'credentials.md',
  CredentialRef: 'credentials.md',
  CredentialKey: 'credentials.md',
  CredentialInfo: 'credentials.md',
  CredentialRecord: 'credentials.md',
  CredentialRecordEntry: 'credentials.md',
  CredentialRecordInfo: 'credentials.md',
  ResolvedCredential: 'credentials.md',
  AskUserQuestionAnswer: 'user-questions.md',
  AskUserQuestionRequest: 'user-questions.md',
  TimedUserQuestionResult: 'user-questions.md',
  UserQuestionProvider: 'user-questions.md',
  WebFetchProvider: 'web.md',
  WebFetchRequest: 'web.md',
  WebFetchResult: 'web.md',
  WebSearchProvider: 'web.md',
  WebSearchRequest: 'web.md',
  WebSearchResult: 'web.md',
  WorkflowRun: 'workflow.md',
  VerifiedWebhookDelivery: 'webhook.md',
  WebhookRule: 'webhook.md',
  PermissionCatalog: 'permission-presets.md',
  PresetOption: 'permission-presets.md',
  PresetSpec: 'permission-presets.md',
  WebRoute: 'web-server.md',
  WebResourceRoute: 'web-server.md',
  IndexInjection: 'web-server.md',
  StorageBackend: 'storage.md',
  StorageForms: 'storage.md',
  Domain: 'storage.md',
  DomainSpec: 'storage.md',
  DomainChanged: 'storage.md',
  DomainFacility: 'storage.md',
  Workspace: 'workspace.md',
  ArchiveSessionOptions: 'workspace.md',
  SessionActivity: 'workspace.md',
  SessionActivityRequest: 'workspace.md',
  WorkspaceArchiveSessionRequest: 'workspace.md',
  WorkspaceArchiveValue: 'workspace.md',
  WorkspaceCreateRequest: 'workspace.md',
  WorkspaceCreateValue: 'workspace.md',
  WorkspaceDeleteRequest: 'workspace.md',
  WorkspaceDeleteValue: 'workspace.md',
  WorkspaceFollowFrame: 'workspace.md',
  WorkspaceId: 'workspace.md',
  WorkspaceInsertBeforeRequest: 'workspace.md',
  WorkspaceInsertSessionBeforeRequest: 'workspace.md',
  WorkspaceOrderValue: 'workspace.md',
  WorkspacePinSessionRequest: 'workspace.md',
  WorkspacePinValue: 'workspace.md',
  WorkspaceRenameRequest: 'workspace.md',
  WorkspaceUnarchiveSessionRequest: 'workspace.md',
  WorkspaceUnpinSessionRequest: 'workspace.md',
  WorkspaceValue: 'workspace.md',
  ClientArtifactBaseline: 'client-modules.md',
  WebBootGraph: 'client-modules.md',
  SessionTelemetryRecord: 'session-telemetry.md',
  WorkflowRunInfo: 'workflow.md',
  WorkflowStartRequest: 'workflow.md',
  ProjectionDefinition: 'session-projection.md',
  ProjectionHandle: 'session-projection.md',
  SessionProjectionMap: 'session-projection.md',
  ProjectionKeySelection: 'session-projection.md',
  ProjectionChangeListener: 'session-projection.md',
  ProjectionSnapshot: 'session-projection.md',
  ProjectionCheckpoint: 'session-projection.md',
  DirectoryPickerCapability: 'workspace.md',
  DirectoryListing: 'workspace.md',
  TypertContribution: 'typert.md',
  TypertRemoteEventSource: 'typert.md',
  RemoteEventHostInfo: 'typert.md',
  TypertFace: 'typert.md',
  TypertPackageFilter: 'typert.md',
  TypertPackageRecord: 'typert.md',
  TypertSchemaFilter: 'typert.md',
  TypertSchemaRecord: 'typert.md',
}

/** TypeScript lib and pinned framework types with no repository-owned data page. */
export const FOUNDATION_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Entry', 'Array',
  'Plugin',
  'AbortSignal',
  'AsyncIterable',
  'Context',
  'Error',
  'EntryTree',
  'Fiber',
  'EntryOptions',
  'Exclude',
  'Extract',
  'Map',
  'NonNullable',
  'Omit',
  'Partial',
  'Pick',
  'Promise',
  'Record',
  'Readonly',
  'ReadonlyMap',
  'ReadonlySet',
  'Request',
  'Response',
  'IncomingMessage',
  'ServerResponse',
  'ReturnType',
  'Uint8Array',
])

/** Project types deliberately documented outside the subsystems catalog. */
export const TYPE_LINK_EXEMPTIONS: Readonly<Record<string, string>> = {
  ActionCardDecision: 'packages/experimental/action-cards/README.md',
  ActionCardKind: 'packages/experimental/action-cards/README.md',
  ActionCardResult: 'packages/experimental/action-cards/README.md',
  ActionCardView: 'packages/experimental/action-cards/README.md',
  RecommendationDetails: 'packages/experimental/plugin-recommendations/README.md',
  ProductEvent: 'Desktop event fields are owned by packages/client/product-analytics/README.md and src/events.ts',
  ConnectionFetchHandler: 'shared Fetch dispatch is owned by packages/client/connection/src/rpc.ts',
  ConnectionRequestRejection: 'transport rejection status is owned by packages/client/connection/src/rpc.ts',
  ConnectionTrustRequest: 'transport authentication input is owned by packages/client/connection/src/rpc.ts',
  PeerAdmission: 'Peer admission outcome is owned by packages/client/connection/src/rpc.ts',
  ConnectionAdmission: 'physical socket admission and release are owned by packages/client/connection/src/rpc.ts',
  PeerScope: 'Peer scope contract is owned by packages/typert/protocol/src/types.ts',
  RemoteAccessPolicy: 'access policy contract is owned by packages/api/remote-access/README.md',
  RemoteAccessRequest: 'Gateway decision requests are owned by packages/api/remote-access/README.md',
  RemoteAccessDecision: 'Gateway decisions are owned by packages/api/remote-access/README.md',
  RemoteAccessFrame: 'access snapshot frames are owned by packages/api/remote-access/README.md',
  RemoteAccessBaseline: 'access snapshot frames are owned by packages/api/remote-access/README.md',
  ConnectionIndexRequest: 'frontend authentication request is owned by packages/client/connection/src/rpc.ts',
  ConnectionIndexResponse: 'frontend authentication response is owned by packages/client/connection/src/rpc.ts',
  Profile: 'resolved profile layers are owned by packages/boot/app-boot/README.md',
  PatchOptions: 'Include patch entries are owned by vendor/include (vendored upstream)',
  McpResourceProvider: 'scoped resource provider is owned by packages/mcp/mcp-resources/README.md',
  'z.ZodType': 'Zod response validation API is owned by https://zod.dev/packages/zod',
  Socket: 'Node.js byte stream API is owned by https://nodejs.org/api/net.html#class-netsocket',
  z: 'schemastery schema constructor is owned by vendor/schemastery (vendored upstream)',
  BeginCommandRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  InsertReferenceRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  ConsumeTokenRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  InsertTextRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  AgentHandle: 'agent ownership handle is owned by packages/core/agent/README.md',
  AgentPreset: 'discovered preset record is owned by packages/preset/agent-preset-registry/README.md',
  AgentPresetRoster: 'path-free preset roster is owned by packages/preset/agent-preset-registry/README.md',
  PresetDefinition: 'declarative configuration is owned by packages/preset/agent-preset/README.md',
  AsyncDisposable: 'TypeScript explicit resource management interface',
  AgentPresetDocument: 'preset composition view is owned by packages/preset/agent-preset-registry/README.md',
  AgentPresetComposition: 'flattened composition rows are owned by packages/preset/agent-preset-registry/README.md',
  AgentPresetInspection: 'retained revision modules and isolation diagnostics are owned by packages/preset/agent-preset-registry/README.md',
  PresetMetadata: 'preset display text is owned by packages/preset/agent-preset-registry/README.md',
  BashEnvContributor: 'service-local extension type is owned by packages/shell/tool-bash/src/index.ts',
  BashEnvVariableInfo: 'service-local metadata type is owned by packages/shell/tool-bash/src/index.ts',
  CompactionAgentContext: 'compaction service input is owned by packages/compaction/compaction/src/index.ts',
  ManualCompactAgentContext: 'manual compaction service input is owned by packages/compaction/compaction/src/index.ts',
  ClientResponse: 'wire response message is owned by packages/client/connection/src/rpc.ts',
  ApprovalRequestId: 'dynamic Plugin approval identity is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisErrorDetails: 'Cordis runtime error payload is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectPlatform: 'Cordis inspect platform identity is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectProviderManifest: 'Cordis inspect provider manifest is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectProviderView: 'Cordis inspect provider view is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectQueryRequest: 'Cordis inspect transport payload is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectQueryResolution: 'Cordis inspect query result is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectQueryResolved: 'Cordis inspect transport payload is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectRequestId: 'Cordis inspect request identity is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisInspectResolveAck: 'Cordis inspect resolution acknowledgement is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisDynamicPackageId: 'dynamic Package identity is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisDynamicPluginId: 'dynamic Plugin identity is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisDynamicPluginRunId: 'dynamic Plugin run identity is owned by packages/extensions/cordis-host-runner/src/types.ts',
  CordisDynamicRunMode: 'dynamic Plugin activation mode is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisClientSource: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisDefineReceipt: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisDefineRequest: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisHostHalfResult: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisInventoryRow: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisInvokeResult: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisPackageInspection: 'dynamic Package source inspection is owned by packages/extensions/cordis-host-runner/src/registry.ts',
  DynamicCordisPluginInspection: 'dynamic Plugin inspection is owned by packages/extensions/cordis-host-runner/src/registry.ts',
  DynamicCordisRequestResolved: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisRetracted: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisRunRequest: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisPackage: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisReference: 'dynamic Plugin reference is owned by packages/extensions/cordis-host-runner/src/registry.ts',
  DynamicCordisRenderFailure: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisResolveAck: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisRunResolution: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisRunResponse: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisSnapshotRow: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisStopResponse: 'dynamic Plugin stop result is owned by packages/extensions/cordis-host-runner/src/types.ts',
  DynamicCordisUndefineReceipt: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  HostCordisInspectProviderRegistration: 'Host inspect provider registration is owned by packages/extensions/cordis-host-runner/src/inspect-registry.ts',
  DomainImpl: 'domain implementation contract is owned by packages/storage/storage-domain/README.md',
  CommandExecution: 'executor return contract is owned by packages/interaction/commands/src/index.ts',
  'z.core.JSONSchema.BaseSchema': 'zod projection output is owned by the zod v4 API',
  'z.core.ToJSONSchemaParams': 'zod projection parameters are owned by the zod v4 API',
  TypertDisposer: 'Typert lifecycle contract is owned by packages/typert/protocol/README.md',
  InvokeRemoteRequest: 'gateway invocation contract is owned by packages/api/gateway/README.md',
  LocaleDict: 'service-local dictionary fields are owned by packages/client/i18n/src/index.ts',
  ThemeTokens: 'service-local token dictionary is owned by packages/client/ui-theme/src/index.ts',
  Translate: 'service-local bound translator is owned by packages/client/i18n/src/index.ts',
  WebUpgradeRoute:
    'upgrade route registration contract is owned by packages/host/webserver/src/index.ts',
  JsonValue: 'JSON value union is owned by packages/core/session/src/json.ts',
  KnobState: 'projection unit state fields are owned by packages/interaction/permission-presets/README.md',
  PromptAssembly: 'assembly result is owned by packages/core/system-prompt/README.md',
  PromptPresentation: 'presentation inputs are owned by packages/core/system-prompt/README.md',
  RequestRunId: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  RpcReceipt: 'carrier-layer receipt is owned by packages/client/connection/src/rpc.ts',
  SessionForkSource: 'service-local fork input is owned by packages/core/session/src/index.ts',
  SubagentRunEndInfo: 'event payload contract is owned by packages/subagent/subagent/src/types.ts',
  SubagentRunInfo: 'event payload contract is owned by packages/subagent/subagent/src/types.ts',
  WorkflowAgentEndInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkflowAgentInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkflowResultInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkspaceFileScope: 'Host workspace file lookup contract is owned by packages/api/workspace-files/README.md',
  WorkspaceByteReadOptions: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceByteRange: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceDirectoryListing: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceFileBytes: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceFileChange: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceFileWatchFrame: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceFileRange: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceFileStat: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  WorkspaceFileText: 'Host workspace file endpoint contract is owned by packages/api/workspace-files/README.md',
  TerminalShell: 'Browser terminal shell profiles are owned by packages/api/terminal-controller/README.md',
  TerminalEnvironment: 'Browser terminal environment fields are owned by packages/api/terminal-controller/README.md',
  WebTerminalInfo: 'Browser terminal metadata is owned by packages/api/terminal-controller/README.md',
  TerminalCreateRequest: 'Browser terminal allocation fields are owned by packages/api/terminal-controller/README.md',
  TerminalInput: 'Browser terminal input commands are owned by packages/api/terminal-controller/README.md',
  TerminalFrame: 'Browser terminal stream frames are owned by packages/api/terminal-controller/README.md',
  TerminalRetentionFrame: 'Browser terminal window holds are owned by packages/api/terminal-controller/README.md',
  WebTerminalId: 'Browser terminal identity is owned by packages/api/terminal-controller/README.md',
}

/** Repository data policy consumed by the Cordis catalog projector. */
export const CORDIS_CATALOG_POLICY: CordisCatalogPolicy = {
  linkedTypePages: LINK_MAP,
  foundationTypeNames: FOUNDATION_TYPE_NAMES,
  typeLinkExemptions: TYPE_LINK_EXEMPTIONS,
  runtimeServiceExclusions: new Set(['cordisInspect', 'dynamicCordisRunner']),
  runtimeServices: [{
    key: 'timer',
    type: 'TimerService',
    abstract: false,
    doc: 'Disposable timer helpers mixed into Cordis contexts.',
    source: 'vendor/timer/src/index.ts:12',
    methods: [
      {
        signature: 'timeout(callback: () => void, delay: number): () => void',
        jsDoc: '/** Run a callback once and return its disposer. */',
      },
      {
        signature: 'timeout(delay: number): Promise<void>',
        jsDoc: '/** Resolve after a delay; disposal rejects the pending promise. */',
      },
      {
        signature: 'interval(callback: () => void, delay: number): () => void',
        jsDoc: '/** Run a callback repeatedly and return its disposer. */',
      },
      {
        signature: 'interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>',
        jsDoc: '/** Return an async iterator of timer ticks. */',
      },
      {
        signature: 'throttle<F extends (...args: any[]) => any>(callback: F, delay: number, noTrailing?: boolean): ((...args: Parameters<F>) => void) & { dispose: () => void }',
        jsDoc: '/** Return a throttled function whose timer is disposed with the current fiber. */',
      },
      {
        signature: 'debounce<F extends (...args: any[]) => any>(callback: F, delay: number): ((...args: Parameters<F>) => void) & { dispose: () => void }',
        jsDoc: '/** Return a debounced function whose timer is disposed with the current fiber. */',
      },
    ],
  }],
  inheritedEvents: [
    { name: 'internal/plugin', summary: 'A plugin fiber was created.', source: 'vendor/cordis/src/events.ts:331' },
    { name: 'internal/status', summary: 'A fiber changed lifecycle state.', source: 'vendor/cordis/src/events.ts:333' },
    { name: 'internal/service', summary: 'Interception hook for a service binding (no core producer).', source: 'vendor/cordis/src/events.ts:341' },
    { name: 'internal/update', summary: 'Waterfall: a fiber config update is being applied.', source: 'vendor/cordis/src/events.ts:343' },
    { name: 'internal/config', summary: 'Waterfall: a fiber config is being resolved before validation.', source: 'vendor/cordis/src/events.ts:339' },
    { name: 'internal/get', summary: 'Waterfall: a service is being read from the store.', source: 'vendor/cordis/src/events.ts:345' },
    { name: 'internal/set', summary: 'Waterfall: a service is being written to the store.', source: 'vendor/cordis/src/events.ts:347' },
    { name: 'internal/listener', summary: 'A listener was registered.', source: 'vendor/cordis/src/events.ts:349' },
    { name: 'internal/dispatch', summary: 'An event is being dispatched to listeners.', source: 'vendor/cordis/src/events.ts:351' },
    { name: 'exit', summary: 'The process is exiting on a signal.', source: 'vendor/loader/src/index.ts:25' },
    { name: 'loader/config-update', summary: 'The loader config tree changed.', source: 'vendor/loader/src/index.ts:26' },
    { name: 'loader/entry-init', summary: 'A config entry is being initialized.', source: 'vendor/loader/src/index.ts:27' },
    { name: 'loader/partial-dispose', summary: 'An entry is being partially disposed on reload.', source: 'vendor/loader/src/index.ts:28' },
    { name: 'loader/patch-context', summary: 'A context is being patched during a reload.', source: 'vendor/loader/src/index.ts:41' },
    { name: 'loader/volatile-update', summary: 'Volatile config values committed into the running fiber without a remount; dispatched to the owning fiber only.', source: 'vendor/loader/src/index.ts:34' },
  ],
  inheritedServices: [
    { name: 'ctx.on / ctx.once', summary: 'Register an event listener (disposable).', source: 'vendor/cordis/src/events.ts:34' },
    { name: 'ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall', summary: 'Dispatch an event (sync / awaited / first-bail / short-circuit chain).', source: 'vendor/cordis/src/events.ts:34' },
    { name: 'ctx.plugin / ctx.inject', summary: 'Load a plugin / declare required services.', source: 'vendor/cordis/src/registry.ts:164' },
    { name: 'ctx.effect', summary: 'Register a disposable side effect tied to the fiber.', source: 'vendor/cordis/src/fiber.ts:9' },
    { name: 'ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin', summary: 'Low-level service-store access and binding.', source: 'vendor/cordis/src/reflect.ts:7' },
    { name: 'ctx.extend / ctx.isolate / ctx.intercept', summary: 'Derive a child context (scoped services / isolation / interception).', source: 'vendor/cordis/src/context.ts:42' },
    { name: 'ctx.root / ctx.fiber / ctx.registry / ctx.reflect / ctx.events / ctx.logger', summary: 'Ambient handles onto the running context graph.', source: 'vendor/cordis/src/context.ts:16' },
    { name: 'ctx.timer (+ interval / timeout / throttle / debounce)', summary: 'Disposable timer helpers. The `timer` key is provided at runtime; the four supported helpers are mixed onto ctx directly (declared via Pick).', source: 'vendor/timer/src/index.ts:4' },
    { name: 'ctx.loader', summary: 'The config Loader that booted the app (present under the loader).', source: 'vendor/loader/src/index.ts:30' },
  ],
}


/**
 * Splice a page's generated Cordis API region into its Markdown content.
 * The page must contain exactly one `cordis-surface` marker region (the markers are
 * part of the hand-owned page skeleton once, then owned by the generator);
 * zero or several is a partition error the caller reports with the page path.
 * The match is on THIS generator's exact markers, not the generic region
 * grammar, so a page carrying only some other generator's region fails loud
 * instead of having that region overwritten.
 * @param content - the page's current full Markdown text.
 * @param region - the freshly rendered marker-delimited region.
 * @returns the page text with the region replaced.
 */
export function spliceRegion(content: string, region: string): string {
  const lines = content.split('\n')
  const begins = lines.flatMap((line, index) => (line === REGION_BEGIN ? [index] : []))
  const ends = lines.flatMap((line, index) => (line === REGION_END ? [index] : []))
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(`expected exactly 1 cordis-surface region, found ${begins.length} BEGIN/${ends.length} END; add the BEGIN/END cordis-surface markers once`)
  }
  const begin = begins[0] ?? -1
  const end = ends[0] ?? -1
  if (end < begin) throw new Error('cordis-surface END marker precedes its BEGIN')
  return [...lines.slice(0, begin), ...region.split('\n'), ...lines.slice(end + 1)].join('\n')
}

/** The declared-vs-rendered inputs {@link walkPartitionProblems} judges. */
export interface WalkPartitionInput {
  /** Service key → source pointer, as the rendering projection produced them. */
  readonly renderedKeys: ReadonlyMap<string, string>
  /** Event scopes the rendering projection produced. */
  readonly renderedScopes: ReadonlySet<string>
  /** Event names the rendering projection produced. */
  readonly renderedEventNames: ReadonlySet<string>
  /** Context key → first declaring file, from the independent AST scan. */
  readonly declaredKeys: ReadonlyMap<string, string>
  /** Event name → first declaring file, from the independent AST scan. */
  readonly declaredEvents: ReadonlyMap<string, string>
}

/** The curated partition maps {@link walkPartitionProblems} enforces. */
export interface WalkPartitionMaps {
  readonly servicePage: Readonly<Record<string, string>>
  readonly serviceWalkExemptions: Readonly<Record<string, string>>
  readonly eventScopePage: Readonly<Record<string, string>>
  readonly eventWalkExemptions: Readonly<Record<string, string>>
}

/** Project paired Markdown destinations in one generated region to the page's locale. */
export function localizePageRegion(region: string, pageRel: string, scanRoot: string = root): string {
  if (!pageRel.endsWith('.zh.md')) return region
  const manifest = parseTranslationPairingManifest(
    readFileSync(resolve(scanRoot, 'scripts/translation-pairing.manifest.json'), 'utf8'),
  )
  return rewriteTranslationLinkLocales(region, {
    repoRoot: scanRoot,
    sourcePath: pageRel,
    isTranslationPairSource: translationPairSourcePredicate(manifest),
  }).content
}

/**
 * Judge the rendered API and the independent AST scan against the curated
 * partition maps, fail-closed in both directions for services AND events: a
 * rendered key/scope must be mapped to a page, a mapped key/scope must still
 * render, and — the backstop — a DECLARED key/event the projection cannot see
 * must carry a named walk exemption (a rendered one must not). A third
 * direction guards the scan itself: everything rendered must also be declared
 * to the scan, so a scan blind spot cannot decay silently. Pure so the
 * acceptance paths are provable without running the projection.
 * @param input - rendered API plus the declared-key/event scans.
 * @param maps - the curated page maps and walk exemptions.
 * @returns one message per violation, empty when the partition holds.
 */
export function walkPartitionProblems(input: WalkPartitionInput, maps: WalkPartitionMaps): string[] {
  const problems: string[] = []
  for (const [key, source] of input.renderedKeys) {
    if (!Object.hasOwn(maps.servicePage, key)) problems.push(`service ctx.${key} (${source}) has no SERVICE_PAGE entry; every service maps to exactly one subsystems page.`)
  }
  for (const scope of [...input.renderedScopes].sort()) {
    if (!Object.hasOwn(maps.eventScopePage, scope)) problems.push(`event scope '${scope}/*' has no EVENT_SCOPE_PAGE entry; every event scope maps to exactly one subsystems page.`)
  }
  for (const key of Object.keys(maps.servicePage)) {
    if (!input.renderedKeys.has(key)) problems.push(`SERVICE_PAGE maps 'ctx.${key}' but the projection discovers no such service; remove the stale entry.`)
  }
  for (const scope of Object.keys(maps.eventScopePage)) {
    if (!input.renderedScopes.has(scope)) problems.push(`EVENT_SCOPE_PAGE maps '${scope}/*' but the projection discovers no such scope; remove the stale entry.`)
  }
  // The rendering projection only sees a Context key it can resolve to a
  // documented service class. The independent scan reads EVERY Context merge
  // so a key the projection cannot render must either be rendered (mapped) or
  // carry a named SERVICE_WALK_EXEMPTIONS reason — never vanish silently.
  for (const [key, rel] of input.declaredKeys) {
    const rendered = input.renderedKeys.has(key)
    const exempt = Object.hasOwn(maps.serviceWalkExemptions, key)
    if (!rendered && !exempt) {
      problems.push(`ctx.${key} (${rel}) is declared in a Context merge but invisible to the rendering projection; map it in SERVICE_PAGE (after making it renderable) or name it in SERVICE_WALK_EXEMPTIONS with its documentation owner.`)
    }
    if (rendered && exempt) problems.push(`ctx.${key} is rendered by the projection but still listed in SERVICE_WALK_EXEMPTIONS; remove the stale exemption.`)
  }
  for (const key of Object.keys(maps.serviceWalkExemptions)) {
    if (!input.declaredKeys.has(key)) problems.push(`SERVICE_WALK_EXEMPTIONS names 'ctx.${key}' but no Context merge declares it; remove the stale exemption.`)
  }
  // The event mirror of the service backstop: the projection walks only files
  // reachable from host-face package exports, so a client-face or unreachable
  // Events merge would otherwise vanish without a trace.
  for (const [name, rel] of input.declaredEvents) {
    const rendered = input.renderedEventNames.has(name)
    const exempt = Object.hasOwn(maps.eventWalkExemptions, name)
    if (!rendered && !exempt) {
      problems.push(`event '${name}' (${rel}) is declared in an Events merge but invisible to the rendering projection; make it renderable (mapped via EVENT_SCOPE_PAGE) or name it in EVENT_WALK_EXEMPTIONS with its documentation owner.`)
    }
    if (rendered && exempt) problems.push(`event '${name}' is rendered by the projection but still listed in EVENT_WALK_EXEMPTIONS; remove the stale exemption.`)
  }
  for (const name of Object.keys(maps.eventWalkExemptions)) {
    if (!input.declaredEvents.has(name)) problems.push(`EVENT_WALK_EXEMPTIONS names '${name}' but no Events merge declares it; remove the stale exemption.`)
  }
  // Self-check the scan itself: everything the projection renders is declared
  // in a Context/Events merge the scan must also reach, so a rendered key or
  // event the scan cannot see means the SCAN regressed (glob, prefilter, or
  // block walk) — a partial blind spot that exemption staleness alone would
  // never appear.
  for (const key of input.renderedKeys.keys()) {
    if (!input.declaredKeys.has(key)) problems.push(`ctx.${key} is rendered by the projection but the independent scan finds no Context merge declaring it; the scan has a blind spot (glob, prefilter, or module-block walk) — fix the scan, not the maps.`)
  }
  for (const name of input.renderedEventNames) {
    if (!input.declaredEvents.has(name)) problems.push(`event '${name}' is rendered by the projection but the independent scan finds no Events merge declaring it; the scan has a blind spot (glob, prefilter, or module-block walk) — fix the scan, not the maps.`)
  }
  return problems
}

/**
 * Compute every generated artifact: the inherited-tier page, the model-facing
 * runtime API module, plus, per mapped subsystems page, the pair's two updated
 * documents with the injected region. Fail-loud partition checks live here: an
 * unmapped service/event scope, a mapping whose page file does not exist, a
 * curated entry whose key/scope the projection no longer discovers, a declared
 * Context key or Events member the projection cannot see without a named walk
 * exemption, and a mapped page missing its markers are all aggregated errors.
 * @returns `[repo-relative path, exact content]` for every generated artifact.
 */
export function computeOutputs(): [string, string][] {
  const { projector, model } = projectCordisCatalog(root, CORDIS_CATALOG_POLICY)
  const services = [...model.services]
  const events = [...model.events]

  const declaredKeys = new Map<string, string>()
  const declaredEvents = new Map<string, string>()
  for (const { rel, sf, body } of contextMergeFiles(root, ['packages/*/*/src/**/*.ts', 'packages/*/*/src/**/*.tsx'])) {
    for (const key of contextKeyMap(body, sf).keys()) {
      if (!declaredKeys.has(key)) declaredKeys.set(key, rel)
    }
    for (const name of eventNameList(body, sf)) {
      if (!declaredEvents.has(name)) declaredEvents.set(name, rel)
    }
  }
  const problems = walkPartitionProblems({
    renderedKeys: new Map(services.map(s => [s.key, s.source])),
    renderedScopes: new Set(events.map(e => e.scope)),
    renderedEventNames: new Set(events.map(e => e.name)),
    declaredKeys,
    declaredEvents,
  }, {
    servicePage: SERVICE_PAGE,
    serviceWalkExemptions: SERVICE_WALK_EXEMPTIONS,
    eventScopePage: EVENT_SCOPE_PAGE,
    eventWalkExemptions: EVENT_WALK_EXEMPTIONS,
  })
  if (problems.length > 0) throw new Error(`gen-cordis-catalog: ${problems.length} partition violation(s):\n${problems.map(p => `  ${p}`).join('\n')}`)

  const pages = [...new Set([...Object.values(SERVICE_PAGE), ...Object.values(EVENT_SCOPE_PAGE)])].sort()
  const outputs: [string, string][] = [
    [OUT_INHERITED, renderInheritedPage(CORDIS_CATALOG_POLICY)],
    [OUT_RUNTIME_API, projector.renderRuntimeApi(model)],
  ]
  for (const page of pages) {
    const region = renderPageRegion(
      page,
      services.filter(s => SERVICE_PAGE[s.key] === page),
      events.filter(e => EVENT_SCOPE_PAGE[e.scope] === page),
      CORDIS_CATALOG_POLICY,
    )
    for (const side of [page, page.replace(/\.md$/, '.zh.md')]) {
      const rel = `${SUBSYSTEMS_DIR}/${side}`
      const localizedRegion = localizePageRegion(region, rel)
      let current: string
      try {
        current = readFileSync(resolve(root, rel), 'utf8')
      } catch {
        // Both pair sides must exist before a region can be injected; the
        // pairing gate owns pair completeness, this generator names the miss.
        problems.push(`${rel}: mapped subsystems page does not exist.`)
        continue
      }
      try {
        outputs.push([rel, spliceRegion(current, localizedRegion)])
      } catch (error) {
        problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (problems.length > 0) throw new Error(`gen-cordis-catalog: ${problems.length} page violation(s):\n${problems.map(p => `  ${p}`).join('\n')}`)
  return outputs
}

/** CLI entry: default regenerates every artifact, `--check` fails if any is
 * stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed files nor calls process.exit.
 * @returns nothing; writes files or reports freshness through the process.
 */
export function main(): void {
  const outputs: [string, string][] = [
    ...computeOutputs(),
    ...renderCordisCoreApiPages(),
  ]
  if (process.argv.includes('--check')) {
    const stale: string[] = []
    for (const [out, content] of outputs) {
      let committed: string | null = null
      try {
        committed = readFileSync(resolve(root, out), 'utf8')
      } catch {
        // Only ENOENT (not yet generated) is expected; a present-but-unreadable
        // file is not a state this repo produces. Either way the remedy is the
        // same — regenerate — so treat a read failure as "stale".
        committed = null
      }
      if (committed !== content) stale.push(out)
    }
    if (stale.length === 0) {
      console.log(`gen-cordis-catalog: ${outputs.length} generated file(s)/region(s) are up to date.`)
      process.exit(0)
    }
    console.error(`gen-cordis-catalog: stale — ${stale.join(', ')}. Run \`pnpm run gen-cordis-catalog\` and commit the result.`)
    process.exit(1)
  }

  let changedPages = 0
  for (const [out, content] of outputs) {
    const destination = resolve(root, out)
    if (existsSync(destination) && readFileSync(destination, 'utf8') === content) continue
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
    changedPages++
  }
  console.log(`gen-cordis-catalog: ${outputs.length} artifact(s) computed, ${changedPages} written.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
