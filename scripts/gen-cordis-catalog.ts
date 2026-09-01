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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  blobHash,
  parsePairMeta,
  parseTranslationPairingManifest,
  partitionGeneratedRegions,
  renderPairMeta,
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
  agentLoop: 'core.md',
  mcpServers: 'tools.md',
  agentDefaultModel: 'core.md',
  agentPresets: 'core.md',
  agents: 'core.md',
  approval: 'approval.md',
  attachments: 'attachment.md',
  shell: 'shell.md',
  shellEnv: 'shell.md',
  clientModules: 'client-modules.md',
  codeRuntime: 'code-runtime.md',
  commands: 'commands.md',
  compaction: 'compaction.md',
  cordisInspect: 'extensions.md',
  authorization: 'credentials.md',
  credentials: 'credentials.md',
  credentialsController: 'credentials.md',
  settingsController: 'settings.md',
  directoryPicker: 'workspace.md',
  deepseekLlmApiExtensions: 'llm-streaming.md',
  dynamicCordisRunner: 'extensions.md',
  e2b: 'subprocess.md',
  fileReferences: 'session-reference.md',
  fs: 'filesystem.md',
  goals: 'goal.md',
  inspector: 'extensions.md',
  webServer: 'web-server.md',
  invariants: 'invariants.md',
  llm: 'llm-streaming.md',
  lsp: 'lsp.md',
  messageFeedback: 'feedback.md',
  permissionPresets: 'permission-presets.md',
  planMode: 'plan.md',
  terminals: 'terminal.md',
  sandbox: 'sandbox.md',
  sandboxPolicy: 'sandbox.md',
  sessionPersistence: 'persistence.md',
  sessionQuery: 'session-query.md',
  sessionFileReferences: 'session-reference.md',
  sessionReferenceResolver: 'session-reference.md',
  sessionProjectionCache: 'session-projection.md',
  sessionProjections: 'session-projection.md',
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
  sessionTelemetry: 'session-telemetry.md',
  agentTeams: 'agent-team.md',
  tokenMeter: 'token-meter.md',
  toolResultPruner: 'compaction.md',
  tools: 'tools.md',
  typert: 'typert.md',
  typertGateway: 'typert.md',
  userQuestions: 'user-questions.md',
  web: 'web.md',
  workflowEngine: 'workflow.md',
  webhookRuntime: 'webhook.md',
  workspaceRegistry: 'workspace.md',
  workspaceController: 'workspace.md',
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
  agent: 'not a service: the DX accessor field on Agent.ctx (root accessor defaulting to undefined) — docs/subsystems/core.md owns the Agent handle',
  appReady: 'not a service: launcher-provided successful-startup signal — packages/boot/cmdline/README.md owns the launcher contract',
  appExit: 'not a service: launcher-provided bounded process-exit callback — packages/boot/cmdline/README.md owns the launcher contract',
  cmdlineArgs: 'not a service: launcher-provided immutable app argument accessor — packages/boot/cmdline/README.md owns the launcher contract',
  configuredAgentIdentities: 'not a service: launcher-provided boot-context value (ConfiguredAgentIdentities | undefined) — packages/core/agent-loop/README.md owns this launcher contract',
  launcherSessionQueryPath: 'not a service: launcher-provided boot-context value (string | undefined) — packages/session-query/session-query-sqlite/README.md owns this launcher contract',
  dshHomePath: 'not a service: boot-provided root accessor function (typeof dshHomePath | undefined) for Loader !!js config expressions — packages/boot/app-boot/README.md owns the boot contract',
  launchEnvironment: 'not a service: launcher-provided root accessor value (LaunchEnvironmentSnapshot | undefined) — packages/util/launch-environment/README.md owns this launcher contract',
  connection: 'interface-typed (HostConnectionHandle); implementing class HostConnectionService is declared in rpc-host.ts — packages/client/connection/README.md owns the API',
  uiRenderer: 'client-side interface-typed browser service — packages/client/ui-renderer/README.md owns the API',
  uiSession: 'client-side Session source adapter — packages/client/ui-session/README.md owns the API',
  uiConversation: 'client-side Conversation registries and assembler — packages/client/ui-conversation/README.md owns the API',
  uiWorkspace: 'client-side Workspace navigation adapter — packages/client/ui-workspace/README.md owns the API',
  settingsSchema: 'client-side schema introspection service — packages/client/ui-settings/README.md owns the API',
  settingsScope: 'client-side settings-namespace transport service — packages/client/ui-settings/README.md owns the API',
  chatFileMentions: 'client-side slot-contract accessor (ChatFileMentions) — packages/client/ui-chat/README.md owns the API',
  commandUi: 'client-side interface-typed browser service — packages/client/ui-commands/README.md owns the API',
  conversation: 'client-side interface-typed browser service — packages/client/ui-conversation/README.md owns the API',
  layout: 'client-side interface-typed browser service — packages/client/ui-layout/README.md owns the API',
  locale: 'client-side interface-typed browser service — packages/client/locale/README.md owns the API',
  modelDirectories: 'client-side interface-typed browser service — packages/client/ui-model-selection/README.md owns the API',
  modules: 'client-side interface-typed browser service — packages/client/modules/README.md owns the API',
  remote: 'client-side interface-typed gateway accessor (ClientRemote) — packages/api/gateway/README.md owns the API',
  sessionLogDownload: 'client-side browser download controller — packages/session-query/session-log-export/README.md owns the API',
  inputTriggers: 'client-side interface-typed browser service — packages/client/ui-input-trigger/README.md owns the API',
  timer: 'client-side dynamic-package timer service — packages/extensions/cordis-client-runner/README.md owns the API',
  slots: 'client-side interface-typed browser service — packages/client/ui-renderer/README.md owns the API',
  theme: 'client-side interface-typed browser service — packages/client/ui-theme/README.md owns the API',
  workspaces: 'client-side interface-typed browser service — packages/api/workspace-controller/README.md owns the API',
}

/**
 * The owning subsystems page for every harness event scope (the segment
 * before the first `/`) the projection renders. Fail-closed exactly like
 * {@link SERVICE_PAGE}. Client-face events (`slash/*`, `theme/change`, …) are
 * invisible to the host-face projection and therefore never reach this map;
 * {@link EVENT_WALK_EXEMPTIONS} names each one with its documentation owner.
 */
export const EVENT_SCOPE_PAGE: Record<string, string> = {
  'agent': 'core.md',
  'agent-loop': 'core.md',
  'agent-preset': 'core.md',
  'api-session': 'session.md',
  'approval': 'approval.md',
  'commands': 'commands.md',
  'cordis': 'extensions.md',
  'authorization': 'credentials.md',
  'credentials': 'credentials.md',
  'domain': 'storage.md',
  'fs': 'filesystem.md',
  'goal': 'goal.md',
  'llm': 'llm-streaming.md',
  'mcp-manager': 'tools.md',
  'session': 'session.md',
  'settings': 'settings.md',
  'skills': 'skills.md',
  'subagent': 'subagent.md',
  'system-prompt': 'system-prompt.md',
  'session-telemetry': 'session-telemetry.md',
  'tools': 'tools.md',
  'user-questions': 'user-questions.md',
  'webserver': 'web-server.md',
  'workflow': 'workflow.md',
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
  Agent: 'core.md',
  AgentCancelCause: 'core.md',
  AgentFactory: 'core.md',
  AgentHandle: 'core.md',
  ModelSelection: 'core.md',
  AllowedModelRoute: 'subagent.md',
  SubagentModelSelectionSettings: 'subagent.md',
  AgentOptions: 'core.md',
  AgentStatus: 'core.md',
  ContentBlock: 'llm-streaming.md',
  CreateAgentOptions: 'core.md',
  GenerateOptions: 'llm-streaming.md',
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
  LlmModelContext: 'llm-streaming.md',
  LlmModelReasoningInfo: 'llm-streaming.md',
  LlmResolvedModelInfo: 'llm-streaming.md',
  LlmFailure: 'llm-streaming.md',
  LlmImageRequestPricing: 'llm-streaming.md',
  LlmModelInfo: 'llm-streaming.md',
  LlmProviderInfo: 'llm-streaming.md',
  LlmConfigurableProvider: 'llm-streaming.md',
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
  SessionListRequest: 'session.md',
  SessionListValue: 'session.md',
  ModelCatalog: 'session.md',
  SessionOpenWorkspacePathRequest: 'session.md',
  SessionOpenWorkspacePathValue: 'session.md',
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
  SessionUpdateQueueRequest: 'session.md',
  SessionUpdateQueueValue: 'session.md',
  SessionStartSource: 'core.md',
  SessionLogSnapshot: 'session-query.md',
  SessionSurfaceSnapshot: 'session-query.md',
  ApprovalOutcome: 'approval.md',
  ApprovalPolicy: 'approval.md',
  ApprovalRequest: 'approval.md',
  ApprovalRequestEvent: 'approval.md',
  ApprovalService: 'approval.md',
  AskUserQuestionRequestEvent: 'user-questions.md',
  EncodedImageAttachment: 'attachment.md',
  ImageAttachmentAccess: 'llm-streaming.md',
  ImageAttachmentRef: 'attachment.md',
  ImageRequestPolicy: 'attachment.md',
  RequestImageAttachment: 'attachment.md',
  SaveImageAttachment: 'attachment.md',
  StoredImageAttachment: 'attachment.md',
  ShellExecRequest: 'shell.md',
  ShellExecSpec: 'shell.md',
  ShellProcess: 'shell.md',
  ShellRunResult: 'shell.md',
  DshEnvironment: 'subprocess.md',
  SubprocessHandle: 'subprocess.md',
  SubprocessOutcome: 'subprocess.md',
  SubprocessOutputRead: 'subprocess.md',
  SubprocessOutputReader: 'subprocess.md',
  SubprocessSpawnSpec: 'subprocess.md',
  SubprocessTerminalHandle: 'subprocess.md',
  SubprocessTerminalSpawnSpec: 'subprocess.md',
  CodeRunRequest: 'code-runtime.md',
  CodeRunResult: 'code-runtime.md',
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
  GoalChanged: 'goal.md',
  GoalRef: 'goal.md',
  GoalView: 'goal.md',
  CreateGoalResult: 'goal.md',
  CommandDefinition: 'commands.md',
  CommandDescriptor: 'commands.md',
  CommandId: 'commands.md',
  CommandResult: 'commands.md',
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
  SessionInspection: 'persistence.md',
  BorrowedSessionSource: 'persistence.md',
  SessionLocation: 'persistence.md',
  SessionPreparation: 'persistence.md',
  SessionPersistenceSnapshot: 'persistence.md',
  SessionRawArtifact: 'persistence.md',
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
  ContinuableStart: 'subagent.md',
  ContinuableStartSpec: 'subagent.md',
  AgentMessageSource: 'subagent.md',
  SubagentCatalog: 'subagent.md',
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
  JobDoneListener: 'jobs.md',
  JobId: 'jobs.md',
  JobRead: 'jobs.md',
  JobSnapshot: 'jobs.md',
  JobStart: 'jobs.md',
  JobsChangedListener: 'jobs.md',
  CreateTeamTaskRequest: 'agent-team.md',
  SendTeamMessageRequest: 'agent-team.md',
  SendTeamMessageResult: 'agent-team.md',
  SpawnTeammateRequest: 'agent-team.md',
  SpawnTeammateResult: 'agent-team.md',
  TeamId: 'agent-team.md',
  TeamMemberView: 'agent-team.md',
  TeamMembership: 'agent-team.md',
  TeamTaskMutationResult: 'agent-team.md',
  TeamTaskId: 'agent-team.md',
  TeamTaskView: 'agent-team.md',
  TeamView: 'agent-team.md',
  TeamWaitResult: 'agent-team.md',
  UpdateTeamTaskRequest: 'agent-team.md',
  TokenMeasurement: 'token-meter.md',
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
  ToolPresentationMode: 'tools.md',
  ToolRuntime: 'tools.md',
  ToolRestriction: 'tools.md',
  ToolSchema: 'tools.md',
  SettingsNamespace: 'settings.md',
  SettingsNamespaceInput: 'settings.md',
  SettingsRegisterOptions: 'settings.md',
  SettingsSectionHooks: 'settings.md',
  SettingsScope: 'settings.md',
  SettingsDescriptor: 'settings.md',
  SettingsDescribeValue: 'settings.md',
  SettingsDocumentOpenValue: 'settings.md',
  AgentPresetDirectoryOpenValue: 'settings.md',
  SettingsNamespaceView: 'settings.md',
  SettingsPathOpView: 'settings.md',
  SettingsSecretView: 'settings.md',
  SettingsPathOp: 'settings.md',
  SettingsDescribeOptions: 'settings.md',
  SettingsUpdateSource: 'settings.md',
  SkillListRequest: 'skills.md',
  SkillListValue: 'skills.md',
  AuthorizationEntry: 'credentials.md',
  AuthorizationFlow: 'credentials.md',
  AuthorizationInteraction: 'credentials.md',
  AuthorizationMethod: 'credentials.md',
  AuthorizationNotice: 'credentials.md',
  AuthorizationOutcome: 'credentials.md',
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
  PresetOption: 'permission-presets.md',
  PresetSpec: 'permission-presets.md',
  InvariantInstaller: 'invariants.md',
  WebRoute: 'web-server.md',
  IndexInjection: 'web-server.md',
  StorageBackend: 'storage.md',
  StorageForms: 'storage.md',
  Domain: 'storage.md',
  DomainSpec: 'storage.md',
  DomainChanged: 'storage.md',
  DomainFacility: 'storage.md',
  Workspace: 'workspace.md',
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
  WorkspaceRenameRequest: 'workspace.md',
  WorkspaceValue: 'workspace.md',
  ClientArtifactBaseline: 'client-modules.md',
  WebBootGraph: 'client-modules.md',
  SessionTelemetryRecord: 'session-telemetry.md',
  WorkflowRunInfo: 'workflow.md',
  WorkflowStartRequest: 'workflow.md',
  ProjectionDefinition: 'session-projection.md',
  SessionProjectionMap: 'session-projection.md',
  SessionProjectionStateMap: 'session-projection.md',
  ProjectionChangeListener: 'session-projection.md',
  ProjectionSnapshot: 'session-projection.md',
  ProjectionCheckpoint: 'session-projection.md',
  DirectoryPickerCapability: 'workspace.md',
  DirectoryListing: 'workspace.md',
  TypertContribution: 'invariants.md',
  TypertRemoteEventSource: 'typert.md',
  RemoteEventHostInfo: 'typert.md',
  TypertFace: 'invariants.md',
  TypertPackageFilter: 'invariants.md',
  TypertPackageRecord: 'invariants.md',
  TypertSchemaFilter: 'invariants.md',
  TypertSchemaRecord: 'invariants.md',
}

/** TypeScript lib and pinned framework types with no repository-owned data page. */
export const FOUNDATION_TYPE_NAMES: ReadonlySet<string> = new Set([
  'AbortSignal',
  'AsyncIterable',
  'Context',
  'Error',
  'EntryTree',
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
  'Uint8Array',
])

/** Project types deliberately documented outside the subsystems catalog. */
export const TYPE_LINK_EXEMPTIONS: Readonly<Record<string, string>> = {
  z: 'schemastery schema constructor is owned by vendor/schemastery (vendored upstream)',
  BeginCommandRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  InsertReferenceRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  ConsumeTokenRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  InsertTextRequest: 'event-local request contract is owned by packages/client/ui-input-trigger/src/types.ts',
  AgentHandle: 'agent ownership handle is owned by packages/core/agent/README.md',
  McpManagedServerStatus: 'managed-server status union is owned by packages/mcp/mcp-manager/README.md',
  McpManagedServerView: 'managed-server list view is owned by packages/mcp/mcp-manager/README.md',
  McpProbeOptions: 'probe options are owned by packages/mcp/mcp-client/README.md',
  McpProbeResult: 'probe outcome union is owned by packages/mcp/mcp-client/README.md',
  AgentPreset: 'discovered preset record is owned by packages/preset/agent-presets/README.md',
  AgentPresetRoster: 'path-free preset roster is owned by packages/preset/agent-presets/README.md',
  AgentPresetDocument: 'preset composition view is owned by packages/preset/agent-presets/README.md',
  AgentPresetComposition: 'flattened composition rows are owned by packages/preset/agent-presets/README.md',
  PresetMetadata: 'preset display text is owned by packages/preset/agent-presets/README.md',
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
  InvariantRegistration: 'service-local lifecycle handle is owned by packages/runtime-diagnostics/invariants/README.md',
  JsonValue: 'JSON value union is owned by packages/core/session/src/json.ts',
  KnobState: 'projection unit state fields are owned by packages/interaction/permission-presets/README.md',
  PermissionSelect: 'permissions projection payload is owned by packages/interaction/permission-presets/src/types.ts',
  PromptAssembly: 'assembly result is owned by packages/core/system-prompt/README.md',
  RequestRunId: 'dynamic-package payload contract is owned by packages/extensions/cordis-host-runner/src/types.ts',
  RpcReceipt: 'carrier-layer receipt is owned by packages/client/connection/src/rpc.ts',
  Sandbox: 'external E2B SDK handle is owned by packages/e2b/e2b/README.md',
  SessionForkSource: 'service-local fork input is owned by packages/core/session/src/index.ts',
  SubagentRunEndInfo: 'event payload contract is owned by packages/subagent/subagent/src/types.ts',
  SubagentRunInfo: 'event payload contract is owned by packages/subagent/subagent/src/types.ts',
  WorkflowAgentEndInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkflowAgentInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
  WorkflowResultInfo: 'event-local snapshot is owned by packages/workflow/workflow/src/index.ts',
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
        signature: 'throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): F & { dispose: () => void }',
        jsDoc: '/** Return a throttled function whose timer is disposed with the current fiber. */',
      },
      {
        signature: 'debounce<F extends (...args: any[]) => void>(callback: F, delay: number): F & { dispose: () => void }',
        jsDoc: '/** Return a debounced function whose timer is disposed with the current fiber. */',
      },
    ],
  }],
  inheritedEvents: [
    { name: 'internal/plugin', summary: 'A plugin fiber was created.', source: 'vendor/cordis/src/events.ts:328' },
    { name: 'internal/status', summary: 'A fiber changed lifecycle state.', source: 'vendor/cordis/src/events.ts:330' },
    { name: 'internal/service', summary: 'Interception hook for a service binding (no core producer).', source: 'vendor/cordis/src/events.ts:332' },
    { name: 'internal/update', summary: 'Waterfall: a fiber config update is being applied.', source: 'vendor/cordis/src/events.ts:334' },
    { name: 'internal/get', summary: 'Waterfall: a service is being read from the store.', source: 'vendor/cordis/src/events.ts:336' },
    { name: 'internal/set', summary: 'Waterfall: a service is being written to the store.', source: 'vendor/cordis/src/events.ts:338' },
    { name: 'internal/listener', summary: 'A listener was registered.', source: 'vendor/cordis/src/events.ts:340' },
    { name: 'internal/dispatch', summary: 'An event is being dispatched to listeners.', source: 'vendor/cordis/src/events.ts:342' },
    { name: 'hmr/change', summary: 'A watched source file changed on disk.', source: 'vendor/hmr/src/index.ts:20' },
    { name: 'hmr/reload', summary: 'Plugins are being reloaded after a change.', source: 'vendor/hmr/src/index.ts:21' },
    { name: 'exit', summary: 'The process is exiting on a signal.', source: 'vendor/loader/src/index.ts:23' },
    { name: 'loader/config-update', summary: 'The loader config tree changed.', source: 'vendor/loader/src/index.ts:24' },
    { name: 'loader/entry-init', summary: 'A config entry is being initialized.', source: 'vendor/loader/src/index.ts:25' },
    { name: 'loader/partial-dispose', summary: 'An entry is being partially disposed on reload.', source: 'vendor/loader/src/index.ts:26' },
    { name: 'loader/patch-context', summary: 'A context is being patched during a reload.', source: 'vendor/loader/src/index.ts:27' },
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
    { name: 'ctx.hmr', summary: 'The hot-module-reload watcher (present under the hmr plugin).', source: 'vendor/hmr/src/index.ts:15' },
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

/**
 * Re-record a pair's `.i18n.yaml` after a region write ONLY when the write is
 * region-confined: both sides' region-stripped content must be byte-equal to
 * the region-stripped previous content whose hashes the record holds. The
 * caller supplies the previous bytes (read before writing); human-content
 * drift leaves the record untouched so the pairing gate still demands the
 * normal translation flow.
 * @param pageRel - repo-relative English page path (`docs/subsystems/x.md`).
 * @param before - pre-write bytes per repo-relative path.
 * @param scanRoot - repository root override for tests.
 * @returns true when the record was refreshed.
 */
export function maybeRecordPair(pageRel: string, before: Map<string, Buffer>, scanRoot: string = root): boolean {
  const zhRel = pageRel.replace(/\.md$/, '.zh.md')
  const metaRel = pageRel.replace(/\.md$/, '.i18n.yaml')
  const metaAbs = resolve(scanRoot, metaRel)
  let meta: string
  try {
    meta = readFileSync(metaAbs, 'utf8')
  } catch {
    // No record yet: a brand-new pair is recorded by the author's --write
    // after review, never silently by regeneration.
    return false
  }
  // The record must contain exactly the two valid entries for THIS pair;
  // a malformed or renamed-key sidecar is the pairing gate's problem to
  // report, never something regeneration silently repairs into validity.
  const recorded = parsePairMeta(meta)
  const names = [pageRel, zhRel].map(rel => rel.split('/').at(-1) ?? rel)
  if (!recorded || recorded.size !== 2 || !names.every(name => recorded.has(name))) return false
  for (const rel of [pageRel, zhRel]) {
    const previous = before.get(rel)
    if (!previous) return false
    if (recorded.get(rel.split('/').at(-1) ?? rel) !== blobHash(previous)) return false
    const current = readFileSync(resolve(scanRoot, rel))
    const strippedBefore = partitionGeneratedRegions(previous.toString('utf8')).stripped
    const strippedAfter = partitionGeneratedRegions(current.toString('utf8')).stripped
    if (strippedBefore !== strippedAfter) return false
  }
  const source = readFileSync(resolve(scanRoot, pageRel))
  const zh = readFileSync(resolve(scanRoot, zhRel))
  writeFileSync(metaAbs, renderPairMeta(pageRel, blobHash(source), zhRel, blobHash(zh)))
  return true
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

  const before = new Map<string, Buffer>()
  for (const [out] of outputs) {
    try {
      before.set(out, readFileSync(resolve(root, out)))
    } catch {
      // First generation of this artifact; nothing to guard, nothing to record.
    }
  }
  let changedPages = 0
  let recorded = 0
  for (const [out, content] of outputs) {
    const destination = resolve(root, out)
    if (before.get(out)?.toString('utf8') === content) continue
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
    changedPages++
  }
  for (const page of [...new Set([...Object.values(SERVICE_PAGE), ...Object.values(EVENT_SCOPE_PAGE)])]) {
    const rel = `${SUBSYSTEMS_DIR}/${page}`
    const zhRel = rel.replace(/\.md$/, '.zh.md')
    const wroteEither = [rel, zhRel].some((side) => {
      const previous = before.get(side)
      return previous !== undefined && previous.toString('utf8') !== readFileSync(resolve(root, side), 'utf8')
    })
    if (wroteEither && maybeRecordPair(rel, before)) recorded++
  }
  console.log(`gen-cordis-catalog: ${outputs.length} artifact(s) computed, ${changedPages} written, ${recorded} pair record(s) refreshed.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
