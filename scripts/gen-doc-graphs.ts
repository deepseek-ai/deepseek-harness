/**
 * Generate the relationship layer above the module, Cordis, and tool catalogs.
 * Enumerable facts come from source; hybrid graphs add manifests for policy the
 * source cannot infer, while curated graphs explain flow and ownership.
 * `--check` verifies the generated set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { projectCordisCatalog } from '@deepseek-ai/dsh-typert-generator'
import { CORDIS_CATALOG_POLICY } from './gen-cordis-catalog.ts'
import type { EventEntry, ServiceEntry } from '@deepseek-ai/dsh-typert-generator'
import {
  collectPackageGraph,
  escapeMermaidLabel as escLabel,
  graphNodeId as nodeId,
  type PackageGraphNode,
} from './package-graph.ts'
import { rewriteTranslationLinkLocales } from './translation-links.ts'
import {
  generatedRegions,
  parseTranslationPairingManifest,
  renderGeneratedRegion,
  spliceGeneratedRegion,
  translationPairSourcePredicate,
} from './translation-pairing.ts'
import { TypeScriptProject } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')
type Pkg = PackageGraphNode

interface GraphDoc {
  rel: string
  content: string
}

interface ServiceRole {
  key: string
  pkg: string
  title: string
  mode: 'core' | 'seam' | 'bundle' | 'service'
  implementations?: string[]
  consumers?: string[]
  companions?: string[]
  note: string
}

interface ExamplePlugin {
  id: string
  name: string
}

interface EventRelation {
  dispatchers: Map<string, Set<string>>
  listeners: Set<string>
}

/** One scanned package source file and its owning package short name. */
export interface PackageSource {
  /** Repository-relative path. */
  rel: string
  /** Package short name from the `packages/<group>/<pkg>/src` path. */
  pkg: string
  /** The bound program source file. */
  sourceFile: ts.SourceFile
}

type EventReceiverKind = 'context' | 'agent-dispatch' | 'events-service'

const GROUP_ORDER = [
  'util',
  'attachment',
  'document',
  'llm',
  'core',
  'typert',
  'goal',
  'experimental',
  'process',
  'bash',
  'pty',
  'sandbox',
  'ssh',
  'fs',
  'skill',
  'compact',
  'subagent',
  'tasks',
  'workflow',
  'web',
  'webhook',
  'spill',
  'todo',
  'plan',
  'cordis',
  'hooks',
  'session-persistence',
  'session-query',
  'session-title',
  'telemetry',
  'storage',
  'workspace',
  'support',
  'acp',
  'ui',
]

const SERVICE_ROLES: ServiceRole[] = [
  {
    key: 'actionCards',
    pkg: 'action-cards',
    title: 'Optional action cards',
    mode: 'service',
    consumers: ['creation-recommendations', 'client-ui-action-cards'],
    note: 'Owns the card tool, card state, user actions and status notices; card kinds register their actions and handlers.',
  },
  {
    key: 'pluginRecommendations',
    pkg: 'plugin-recommendations',
    title: 'Explicit-need plugin recommendations',
    mode: 'service',
    consumers: ['client-ui-plugin-recommendations'],
    note: 'Reads the current catalog text of an official plugin card and enables the plugin through the profile plugin manager after a click.',
  },
  {
    key: 'headlessStartup',
    pkg: 'headless',
    title: 'Headless invocation options',
    mode: 'core',
    consumers: ['headless'],
    note: 'Supplies parsed task and run options to the headless runner and its sandbox-policy configuration.',
  },
  {
    key: 'cotTranslation',
    pkg: 'experimental-client-ui-cot-translation',
    title: 'Reasoning translation Remote',
    mode: 'service',
    note: 'Serves reasoning translations, reuses saved results, and joins ordinary Session activation for uncached inactive Sessions.',
  },
  {
    key: 'translator',
    pkg: 'experimental-translator',
    title: 'Anonymous text translation',
    mode: 'service',
    consumers: ['experimental-client-ui-cot-translation'],
    note: 'Resolves Google or Bing requests and retains shared experimental records through the active Session writer.',
  },
  {
    key: 'hmr',
    pkg: 'hmr',
    title: 'Serialized module and configuration reloads',
    mode: 'core',
    consumers: ['app-boot'],
    note: 'Owns module and exact configuration watchers; application mutations share its queue and automatic reloads await the application file lock.',
  },
  {
    key: 'pluginRegistryProbe',
    pkg: 'client-ui-plugin-manager',
    title: 'Host registry response comparison',
    mode: 'core',
    consumers: ['client-ui-plugin-manager'],
    note: 'Races public registry responses on the Host; the Client owns the initial registry recommendation.',
  },
  {
    key: 'pluginManager',
    pkg: 'plugin-manager',
    title: 'Current-profile plugin and bundle management',
    mode: 'core',
    consumers: ['plugin-manager', 'ui-settings-plugin-inventory'],
    note: 'Shares profile package operations with the CLI and reports persisted and running state to Web and agent callers.',
  },
  {
    key: 'pluginMarket',
    pkg: 'plugin-market',
    title: 'Plugin market index reader',
    mode: 'core',
    consumers: ['client-ui-plugin-market', 'plugin-market'],
    note: 'Fetches and validates the index sources the user configures; installation goes through the plugin manager.',
  },
  {
    key: 'profileContext',
    pkg: 'app-boot',
    title: 'Launcher-owned profile data',
    mode: 'core',
    consumers: ['plugin-manager'],
    note: 'The dsh launcher supplies data-only profile locations and composition inputs; reload scheduling belongs to dsh-hmr.',
  },
  {
    key: 'connection',
    pkg: 'client-connection',
    title: 'Authenticated browser transport',
    mode: 'core',
    consumers: ['api-gateway', 'host-frontend-static'],
    note: 'Owns browser authentication and shared HTTP request dispatch; API adapters register endpoints and streams.',
  },
  {
    key: 'forge',
    pkg: 'experimental-forge',
    title: 'Code host change requests',
    mode: 'seam',
    implementations: ['experimental-forge-github'],
    consumers: ['experimental-forge-session', 'experimental-client-ui-forge'],
    note: 'Providers map remote and change request URLs, look up change requests by head branch, and read status in batches; watchers of one change request share one polling loop.',
  },
  {
    key: 'forgeSession',
    pkg: 'experimental-forge-session',
    title: 'Session change request bindings',
    mode: 'service',
    consumers: ['experimental-client-ui-forge'],
    note: 'A Session projection derives bindings from shell results and binding records and publishes their URLs without status to clients; push results trigger head-branch discovery, and Session watchers poll bound change requests through the forge registry.',
  },
  {
    key: 'forgePanel',
    pkg: 'experimental-client-ui-forge',
    title: 'Forge panel Remote',
    mode: 'service',
    note: 'Streams one panel state per followed Session: Git inspection using Session permissions, the recognized code host and its sign-in, and the bound change requests with polled status.',
  },
  {
    key: 'worktrees',
    pkg: 'experimental-worktree',
    title: 'Git worktree creation',
    mode: 'seam',
    implementations: ['experimental-worktree'],
    consumers: ['experimental-tool-worktree'],
    note: 'Explicit experimental creation from a pinned local commit. Existing write permissions govern checkout and shared Git metadata; the working-directory service owns the resulting Session directory.',
  },
  {
    key: 'workingDirectory',
    pkg: 'working-directory',
    title: 'Session working directory',
    mode: 'seam',
    implementations: ['working-directory'],
    consumers: ['tool-working-directory', 'tool-fs', 'tool-bash', 'tool-pwsh', 'subagent', 'sdk-jsonrpc-server'],
    note: 'One Session projection owns the effective execution directory. The filesystem validates changes; user context reports them while original metadata and write grants stay fixed.',
  },
  {
    key: 'mcpResources',
    pkg: 'mcp-resources',
    title: 'Scoped MCP resource access',
    mode: 'seam',
    implementations: ['mcp-client'],
    consumers: ['mcp-resources'],
    note: 'Connection-owned providers serve shared resource tools in the calling agent scope.',
  },
  {
    key: 'browserUse',
    pkg: 'browser-use',
    title: 'Browser-use provider registration',
    mode: 'seam',
    implementations: ['experimental-browser-use-playwright-mcp', 'experimental-browser-use-chrome-devtools-mcp', 'experimental-browser-use-stagehand-native'],
    consumers: ['experimental-browser-use-playwright-mcp', 'experimental-browser-use-chrome-devtools-mcp', 'experimental-browser-use-stagehand-native'],
    note: 'One provider-owned name per service instance. Providers own their tools and browser resources per live Session; the shared service has no browser operation API.',
  },
  {
    key: 'computerUse',
    pkg: 'computer-use',
    title: 'Computer-use provider registration',
    mode: 'seam',
    implementations: ['experimental-computer-use-cua-driver-mcp', 'experimental-computer-use-cua-driver-native'],
    consumers: ['experimental-computer-use-cua-driver-mcp', 'experimental-computer-use-cua-driver-native'],
    note: 'One provider-owned name per service instance. Each provider also owns its model tools; the service has no common action API, runtime selection, or Session workflow lock.',
  },
  {
    key: 'cuaAccess', pkg: 'cua', title: 'Computer Use permission controls',
    mode: 'core', consumers: ['cua'],
    note: 'The native provider owns application consent and cancellation; the optional Client page queries and changes those decisions through its Remote.',
  },
  {
    key: 'officeToPdf', pkg: 'office-to-pdf', title: 'Office to PDF conversion',
    mode: 'core', consumers: ['client-ui-sidebar-documentpreview'],
    note: 'Authorized Office bytes are converted on the Host using the declared native target engine, or Node WASM when no native target is declared.',
  },
  {
    key: 'attachments',
    pkg: 'attachment',
    title: 'Durable binary attachment storage',
    mode: 'seam',
    implementations: ['attachment-local'],
    consumers: ['api-session-controller', 'tool-fs', 'llm-pi-ai', 'llm-deepseek'],
    note: 'The host commits accepted images before session events; provider adapters resolve authorized durable references into provider-native content.',
  },
  {
    key: 'fileUploads',
    pkg: 'client-file-upload',
    title: 'Agent-scoped staged file uploads',
    mode: 'core',
    consumers: ['api-session-controller'],
    note: 'Owns streaming intake, durable storage, and staged receipt lifetime; the Session controller binds receipts to accepted submissions.',
  },
  {
    key: 'llm',
    pkg: 'llm',
    title: 'LLM adapter registry',
    mode: 'seam',
    implementations: ['llm-deepseek', 'llm-pi-ai', 'llm-replay'],
    consumers: ['agent-loop', 'compaction-basic'],
    note: 'Adapters register provider implementations; the loop and compaction call the provider-neutral stream service.',
  },
  {
    key: 'sessionLogDeepSeek',
    pkg: 'session-log-deepseek',
    title: 'Session-log upload policy',
    mode: 'core',
    implementations: [],
    note: 'Plugins register caller-owned exclusions before the canonical Session-log request contribution is prepared; unmatched requests use normal upload eligibility.',
  },
  {
    key: 'deepseekLlmApiExtensions',
    pkg: 'deepseek-llm-api-extensions',
    title: 'Official DeepSeek request extensions',
    mode: 'seam',
    implementations: ['session-log-deepseek', 'plugin-package-inventory-deepseek'],
    consumers: ['llm-deepseek'],
    note: 'Plugins prepare independent top-level fields; the official adapter merges them and commits their delivery state after HTTP acceptance.',
  },
  {
    key: 'tokenMeter',
    pkg: 'token-meter',
    title: 'Replay token measurement',
    mode: 'core',
    consumers: ['compaction-basic'],
    note: 'Owns isolated per-session replay folds; pressure consumers share immutable revisioned measurements.',
  },
  {
    key: 'toolResultPruner',
    pkg: 'compaction-tool-result-pruner',
    title: 'Model-free tool-result pruning',
    mode: 'core',
    consumers: ['compaction-basic'],
    note: 'Rewrites oversized current tool results through replayable single-node surface replacements before summary compaction.',
  },
  {
    key: 'sessions',
    pkg: 'session',
    title: 'In-memory session store',
    mode: 'core',
    consumers: ['agent-loop', 'agent', 'session-persistence', 'session-query', 'session-query-sqlite', 'subagent', 'message-feedback'],
    note: 'Owns append-only Session instances and emits the durable session event feed.',
  },
  {
    key: 'speechController',
    pkg: 'experimental-api-speech-to-text',
    title: 'Experimental transcription Remote',
    mode: 'core',
    note: 'Validates bounded browser audio before provider dispatch.',
  },
  {
    key: 'sessionController',
    pkg: 'api-session-controller',
    title: 'Host Session Remote controller',
    mode: 'core',
    note: 'Owns Session commands, cold reads, durable-event following, live control state, model catalogs, workspace opening, and Agent activation policy.',
  },
  {
    key: 'sessionFileReferences',
    pkg: 'api-session-controller',
    title: 'Session-addressed file-reference Remote adapter',
    mode: 'core',
    note: 'Delegates file-reference discovery through the Session Controller\'s established Agent lookup policy.',
  },
  {
    key: 'sessionSkillCatalog',
    pkg: 'api-session-controller',
    title: 'Session-addressed skill Remote adapter',
    mode: 'core',
    note: 'Lists the Session composition\'s user-invocable skills without activating a cold Agent.',
  },
  {
    key: 'jobController',
    pkg: 'api-job-controller',
    title: 'Host job Remote controller',
    mode: 'core',
    note: 'Streams one background job\'s observation record over the generated Remote namespace; the roster stays on the session control stream.',
  },
  {
    key: 'credentialsController',
    pkg: 'api-settings-controller',
    title: 'Host credential-surface Remote controller',
    mode: 'core',
    note: 'Projects the credential-reference seam onto the generated Remote namespace: batch fan-out, view projection, and refusal mapping live here, not on the seam Definition.',
  },
  {
    key: 'settingsController',
    pkg: 'api-settings-controller',
    title: 'Host settings-surface Remote controller',
    mode: 'core',
    note: 'Projects the user-settings seam onto the generated Remote namespace: the read is always redacted and every refusal is classified here, not on the seam Definition.',
  },
  {
    key: 'workspaceFiles',
    pkg: 'api-workspace-files',
    title: 'Host workspace file Remote service',
    mode: 'core',
    note: 'Serves stat, paged text, byte windows, directory listings, and the change feed for files inside a Session\'s workspace root, confined by lstat, containment, and a stat re-check.',
  },
  {
    key: 'workspaceChanges',
    pkg: 'workspace-changes',
    title: 'Host per-turn changed-file summaries',
    mode: 'core',
    note: 'Serves the summary each workspace/changes event announced and each listed file\'s turn-start and turn-end comparison, by Session and event sequence, until that Session is disposed; the log carries only the turn.',
  },
  {
    key: 'terminalController',
    pkg: 'api-terminal-controller',
    title: 'Session interactive terminal Remote controller',
    mode: 'core',
    note: 'Owns user terminal processes, default shell resolution and bounded screen recovery through the subprocess provider and typed Remote transport.',
  },
  {
    key: 'workspaceController',
    pkg: 'api-workspace-controller',
    title: 'Host Workspace Remote controller',
    mode: 'core',
    note: 'Owns Workspace commands and reconnect-safe Workspace state delivery through the generated Remote namespace.',
  },
  {
    key: 'directoryPickerController',
    pkg: 'api-workspace-controller',
    title: 'Host directory-picking Remote controller',
    mode: 'core',
    note: 'Carries the picking seam onto the wire: capability gating, cancellation, and the seam-coded failures a browser directory flow discriminates on.',
  },
  {
    key: 'typert',
    pkg: 'typert-registry',
    title: 'Runtime type registry',
    mode: 'core',
    consumers: ['typert-loader', 'api-gateway'],
    note: 'Plugins register live zod contributions directly or through dsh-typert-loader; the API gateway consumes invocation descriptors and providers, while other runtime consumers query schemas and reflection metadata at their own edges.',
  },
  {
    key: 'typertGateway',
    pkg: 'api-gateway',
    title: 'Typert Host invocation gateway',
    mode: 'core',
    note: 'Associates generated Remote descriptors with live Cordis services, resolves registered identities, and exposes unary calls through the shared Connection RPC carrier.',
  },
  {
    key: 'remoteAccess',
    pkg: 'api-remote-access',
    title: 'Remote method access control',
    mode: 'core',
    consumers: ['api-gateway', 'api-session-controller', 'api-workspace-controller'],
    note: 'Decides which Remote methods a non-owner Peer may call through business-registered role-based policies, filters list results, and streams each Peer access snapshot.',
  },
  {
    key: 'sessionPersistence',
    pkg: 'session-persistence',
    title: 'Durable session persistence seam',
    mode: 'seam',
    implementations: ['session-persistence-jsonl'],
    consumers: ['agent-loop', 'tool-bash', 'hooks-claude-code', 'hooks-codex', 'session-query', 'session-query-sqlite', 'message-feedback'],
    note: 'The JSONL backend persists the SessionEvent vocabulary as one artifact per Session.',
  },
  {
    key: 'configEditor',
    pkg: 'config-editor',
    title: 'Profile configuration edits',
    mode: 'core',
    consumers: ['settings', 'agent-default-model'],
    note: 'Persists profile config patches under the application file lock and HMR queue, then reconciles Loader entries.',
  },
  {
    key: 'settings',
    pkg: 'settings',
    title: 'Plugin configuration forms',
    mode: 'core',
    consumers: ['api-settings-controller'],
    note: 'Forms project volatile Config fields from active profile entries and delegate validated edits to config-editor. Plugins consume their own Config references.',
  },
  {
    key: 'subagentModelSelection',
    pkg: 'tool-subagent',
    title: 'Subagent model-selection preference',
    mode: 'core',
    consumers: ['tool-subagent'],
    note: 'Owns the default-off settings namespace that Agent-scoped delegation tools sample when composing a new top-level Session.',
  },
  {
    key: 'credentials',
    pkg: 'credentials',
    title: 'Credential seam',
    mode: 'seam',
    implementations: ['credentials-local'],
    consumers: ['api-settings-controller', 'llm-deepseek', 'llm-pi-ai'],
    note: 'Configuration carries references to secrets; providers own the values. Consumers resolve per operation, so a rotated credential reaches the very next request; the settings controller exposes value-free views and write-only storage.',
  },
  {
    key: 'deepseekAccount',
    pkg: 'deepseek-account',
    title: 'DeepSeek account',
    mode: 'seam',
    implementations: ['deepseek-account-platform'],
    consumers: ['api-account-controller', 'llm-deepseek'],
    note: 'The Host owns browser authorization and local credentials; UI consumers receive state without tokens.',
  },
  {
    key: 'authorization',
    pkg: 'authorization',
    title: 'Authorization flow registry',
    mode: 'seam',
    implementations: [],
    consumers: ['llm-pi-ai'],
    note: 'Flows are registered by the plugin that knows how to obtain one credential and keyed by the record they write; the seam owns the conversation and the one-attempt-per-key lifecycle, never the protocol.',
  },
  {
    key: 'productAnalytics',
    pkg: 'client-product-analytics',
    title: 'Desktop interaction collection',
    mode: 'service',
    note: 'Accepts selected Desktop events, enriches available login identity, and observes live compaction under the live Host collection policy.',
  },
  {
    key: 'otel',
    pkg: 'otel',
    title: 'Shared OTel reporting channels',
    mode: 'service',
    consumers: ['host-product-telemetry-otel', 'session-telemetry-otel'],
    note: 'Product analytics and Session feedback adapters create independent reporting channels through one injected service.',
  },
  {
    key: 'productTelemetry',
    pkg: 'host-product-telemetry-otel',
    title: 'Product usage event sender',
    mode: 'service',
    note: 'Exports explicitly submitted analytics events through OTLP/HTTP; mounting alone collects nothing.',
  },

  {
    key: 'sessionTelemetry',
    pkg: 'session-telemetry',
    title: 'Session telemetry seam',
    mode: 'seam',
    implementations: ['session-telemetry-otel'],
    consumers: [],
    note: 'The seam captures, redacts, and hands session records to one backend; nothing else consumes the service — its output leaves the process.',
  },
  {
    key: 'storage',
    pkg: 'storage',
    title: 'Non-session storage hub',
    mode: 'seam',
    implementations: ['storage-json', 'storage-sqlite'],
    consumers: ['storage-domain'],
    note: 'Backends register side by side under names; data forms (domain first) mount on the hub and translate typed operations into opaque KV-unit primitives.',
  },
  {
    key: 'storageDomain',
    pkg: 'storage-domain',
    title: 'Domain data facility',
    mode: 'core',
    consumers: ['workspace'],
    note: 'Waits for every configured backend, then publishes the domain form as one lifecycle-bound service for typed durable state.',
  },
  {
    key: 'messageFeedback',
    pkg: 'message-feedback',
    title: 'Lifecycle-bound message feedback',
    mode: 'core',
    note: 'Owns per-assistant-message feedback in the canonical Session log, target validation, per-item compare-and-set, and the Host unary Remote contract. Feedback stays outside model history; log export follows the consumer policy.',
  },
  {
    key: 'sessionFeedback',
    pkg: 'command-feedback',
    title: 'Session-level feedback recorder',
    mode: 'core',
    note: 'Records one Session-level remark with its category as a log-only feedback/record event on a live Session through the Host unary Remote contract; the /feedback command shares the same producer.',
  },
  {
    key: 'workspaceRegistry',
    pkg: 'workspace',
    title: 'Workspace entity registry',
    mode: 'core',
    consumers: ['api-workspace-controller', 'api-session-controller'],
    note: 'Owns WorkspaceId-branded records over the domain facility; stable sessionIds accounts drive Host RPC and GUI projections.',
  },
  {
    key: 'sessionQuery',
    pkg: 'session-query',
    title: 'Session reads, traces, filters, and search',
    mode: 'seam',
    implementations: ['session-query-sqlite'],
    consumers: ['session-reference', 'tool-session-query'],
    note: 'The interface supplies exact reads, filters, and traces; its concrete backend adds full-text reconciliation, ranking, snippets, and cursor generations, while the model consumer owns workspace authority and cursor-free rendering.',
  },
  {
    key: 'fileReferences',
    pkg: 'file-reference',
    title: 'File reference discovery',
    mode: 'seam',
    implementations: ['file-reference-local'],
    consumers: ['api-session-controller'],
    note: 'The interface returns path-only completion candidates within an Agent cwd; providers own namespace access and ranking without reading file contents.',
  },
  {
    key: 'sessionReferenceResolver',
    pkg: 'session-reference',
    title: 'Cross-session snapshot preparation',
    mode: 'core',
    note: 'Projects bounded current-surface conversation snapshots into durable untrusted message context; host adapters own mention syntax.',
  },
  {
    key: 'sessionTitle',
    pkg: 'session-title',
    title: 'Log-backed session titles',
    mode: 'seam',
    implementations: ['session-title-first-prompt-llm', 'session-title-all-prompts-llm'],
    note: 'Owns the deterministic fallback, latest-title fold, and sole optional asynchronous provider registration.',
  },
  {
    key: 'systemPrompt',
    pkg: 'system-prompt',
    title: 'System prompt assembly registry',
    mode: 'core',
    consumers: ['agent-loop', 'tools', 'tool-fs', 'tool-terminal', 'tool-web'],
    note: 'Collects prompt sections and model-facing tool schemas for each step.',
  },
  {
    key: 'tools',
    pkg: 'tools',
    title: 'Scoped tool registry and executor selection',
    mode: 'core',
    consumers: ['agent-loop', 'tool-ask-user', 'tool-bash', 'tool-cordis', 'tool-fs', 'tool-terminal', 'tool-skill', 'tool-subagent', 'tool-todo', 'tool-web'],
    note: 'Registers capabilities and scoped executors. Native and PTC providers own descriptions and complete raw call batches; their optional shared pipeline handles tool policy and dispatch.',
  },
  {
    key: 'userQuestions',
    pkg: 'user-questions',
    title: 'Human question/answer seam',
    mode: 'seam',
    consumers: ['tool-ask-user'],
    note: 'UI front ends provide the active human-answer provider; tool-ask-user pauses a tool call on the provider-neutral ask() promise.',
  },
  {
    key: 'planMode',
    pkg: 'plan-mode',
    title: 'Plan collaboration state',
    mode: 'core',
    note: 'Folds logged plan/mode state, flushes user selections at turn boundaries, renders deployment-owned guidance, registers /plan, and keeps the plan-exit schema stable across transitions.',
  },
  {
    key: 'agentPresets',
    pkg: 'agent-preset-registry',
    title: 'Per-session agent composition',
    mode: 'core',
    note: 'Eagerly mounts YAML-declared preset revisions, binds Agents and cold readers to scoped contributions, and retains retired revisions until their last user releases them.',
  },
  {
    key: 'commands',
    pkg: 'commands',
    title: 'Human command registry',
    mode: 'core',
    note: 'Plugins register direct human commands without sending invocations to the model.',
  },
  {
    key: 'sessionProjections',
    pkg: 'session-projection',
    title: 'Session projection units',
    mode: 'core',
    consumers: ['api-session-controller', 'tool-todo', 'session-title'],
    note: 'Domains register state-driven fold units; the eager drive keeps per-session watermark states and the Session controller serves baselines and pushes changed values.',
  },
  {
    key: 'sessionProjectionCache',
    pkg: 'session-projection-cache',
    title: 'Persisted projection cache',
    mode: 'core',
    consumers: ['api-session-controller', 'session-query', 'session-reference'],
    note: 'Durably checkpoints projection unit states per session (throttled + turn/end/detach mandatory points), serves cached projection views, and accelerates prepared-Session projection hydration.',
  },
  {
    key: 'skills',
    pkg: 'skill',
    title: 'Skill provider registry',
    mode: 'seam',
    implementations: ['sandbox-windows-acl', 'skill-badge', 'skill-filesystem', 'skill-office'],
    consumers: ['tool-skill'],
    note: 'Merges provider skill catalogs; tool-skill renders the session-prefix catalog and loads complete skill bodies.',
  },
  {
    key: 'agents',
    pkg: 'agent',
    title: 'Agent service',
    mode: 'core',
    consumers: ['agent-loop', 'acp', 'subagent'],
    note: 'Owns live Agent handles, the create/resume factory seam, and process-local initiator propagation.',
  },
  {
    key: 'agentDefaultModel',
    pkg: 'agent-default-model',
    title: 'Default Agent model selection',
    mode: 'core',
    consumers: ['api-session-controller', 'headless'],
    note: 'Reads the default ModelSelection from volatile Config and saves selections through the profile editor.',
  },
  {
    key: 'agentLoop',
    pkg: 'agent-loop',
    title: 'Concrete loop driver',
    mode: 'bundle',
    consumers: ['base', 'sdk-minimal'],
    note: 'The one concrete loop plugin; extension packages depend on dsh-agent events and services, not on this package.',
  },
  {
    key: 'schedule',
    pkg: 'schedule',
    title: 'Host scheduled messages',
    mode: 'core',
    note: 'Stores tasks independently of Session activation and queues due messages in each task\'s target Session.',
  },
  {
    key: 'goals',
    pkg: 'goal',
    title: 'Same-session goal domain',
    mode: 'core',
    note: 'Folds revisioned objective state from the session log and keeps live continuation activation process-local.',
  },
  {
    key: 'ssh',
    pkg: 'ssh',
    title: 'POSIX SSH connection owner',
    mode: 'core',
    consumers: ['fs-ssh', 'subprocess-ssh', 'sandbox-ssh'],
    note: 'Owns one authenticated OpenSSH connection, installed helper identity, independent program streams and disconnect cleanup for the paired remote providers.',
  },
  {
    key: 'subprocess',
    pkg: 'subprocess',
    title: 'Subprocess seam',
    mode: 'seam',
    implementations: ['subprocess-local', 'subprocess-ssh'],
    consumers: ['bash-local', 'bash-sandbox', 'terminal-bash', 'lsp-stdio', 'subagent-acp', 'subagent-codex', 'subagent-claude-code'],
    note: 'The bash executors, the PTY shell backend, the LSP host, and the out-of-process ACP, Codex, and Claude Code subagent backends spawn through ctx.subprocess; the service owns process coordinates, tree/session lifetime, stdio dispositions, terminal mechanics, and kill escalation.',
  },
  {
    key: 'shell',
    pkg: 'shell',
    title: 'Bash executor seam',
    mode: 'seam',
    implementations: ['bash-local', 'bash-sandbox', 'pwsh-local'],
    consumers: ['tool-bash', 'tool-pwsh', 'hooks-claude-code', 'hooks-codex'],
    note: 'The model-facing shell tools and hook bridges consume this seam; sandboxed, remote, or PowerShell executors replace bash-local without touching them.',
  },
  {
    key: 'shellEnv',
    pkg: 'shell-env',
    title: 'Managed bash environment registry',
    mode: 'core',
    consumers: ['tool-bash', 'tool-pwsh'],
    note: 'Plugins declare effect-scoped DSH_* facts; each shell tool collects one trusted snapshot per execution and its executor rebuilds the namespace.',
  },
  {
    key: 'terminals',
    pkg: 'terminal',
    title: 'Persistent PTY session registry',
    mode: 'seam',
    implementations: ['terminal-bash'],
    consumers: ['tool-terminal'],
    note: 'The registry owns exact-Agent session identity and cleanup; backends own terminal mechanics, while tool-terminal exposes the owner-scoped model tools.',
  },
  {
    key: 'sandbox',
    pkg: 'sandbox',
    title: 'Process-sandbox seam',
    mode: 'seam',
    implementations: ['sandbox-local', 'sandbox-ssh'],
    consumers: ['bash-sandbox', 'terminal-bash'],
    note: 'Consumers hand over the exact argv they are about to spawn; same-world backends wrap it under a per-call policy and report enforcement.',
  },
  {
    key: 'sandboxPolicy',
    pkg: 'sandbox-policy',
    title: 'Sandbox policy home',
    mode: 'core',
    implementations: [],
    consumers: ['bash-sandbox', 'fs-sandbox', 'terminal-bash'],
    note: 'The one home for the deployment default mode + workspace root; only the sandboxed executor and provider read the service (the tool layers use the pure `sandbox/mode` fold it also exports). Both enforcing families read it so bash and fs cannot confine to different roots.',
  },
  {
    key: 'approval',
    pkg: 'user-approval',
    title: 'Approval seam',
    mode: 'seam',
    implementations: [],
    consumers: ['tools', 'tool-bash', 'acp'],
    note: 'One-shot permission decisions dispatched over the `approval/request` waterfall; answerers are listeners (the ACP bridge for its own agents), absence fails closed to `unavailable`.',
  },
  {
    key: 'permissionPresets',
    pkg: 'permission-presets',
    title: 'Permission presets',
    mode: 'core',
    implementations: [],
    note: 'User-facing preset table (`workspace-write`/`danger-full-access`) bundling the sandbox-mode and approval-policy knobs; a switch writes one `permission/preset` event through to both knob events.',
  },
  {
    key: 'ptcRuntime',
    pkg: 'ptc-runtime',
    title: 'PTC execution seam',
    mode: 'seam',
    implementations: ['ptc-runtime-node', 'experimental-ptc-runtime-python'],
    consumers: ['tool-executor-ptc', 'workflow-ptc'],
    note: 'Runs programs against host-provided async bindings; tool-executor-ptc owns PTC presentation and workflow-ptc owns workflow orchestration.',
  },
  {
    key: 'fs',
    pkg: 'fs',
    title: 'Filesystem provider seam',
    mode: 'seam',
    implementations: ['fs-local', 'fs-sandbox', 'fs-ssh'],
    consumers: ['tool-fs'],
    companions: ['fs-observation-policy'],
    note: 'tool-fs executes read/write/edit through ctx.fs; fs-sandbox fences mutations by the shared sandbox mode; fs-observation-policy contributes observed-state checks through the fs/* event gate.',
  },
  {
    key: 'compaction',
    pkg: 'compaction',
    title: 'Compaction seam',
    mode: 'seam',
    implementations: ['compaction-basic'],
    consumers: ['compaction-basic'],
    note: 'The basic backend consumes post-step pressure and request-error recovery events; there is no model-facing compact tool.',
  },
  {
    key: 'subagents',
    pkg: 'subagent',
    title: 'Subagent provider and continuation service',
    mode: 'seam',
    implementations: ['subagent-spawn-in-process', 'subagent-fork-in-process', 'subagent-acp', 'subagent-codex', 'subagent-claude-code', 'subagent-dsh-sdk'],
    consumers: ['tool-subagent', 'tool-subagent-control', 'tool-ralph'],
    note: 'Providers prepare local children or execute external tasks; one activation manager owns both lifecycles. The delegation tool selects a backend, control tools deliver local follow-ups, and workflows await activation results.',
  },
  {
    key: 'speechToText',
    pkg: 'experimental-speech-to-text',
    title: 'Experimental speech recognition providers',
    mode: 'seam',
    implementations: ['experimental-speech-to-text-sensevoice'],
    consumers: ['experimental-api-speech-to-text'],
    note: 'Routes explicit recognizers; the browser uses the authenticated Remote and keeps transcripts in the draft until submission.',
  },
  {
    key: 'agentTeams',
    pkg: 'experimental-agent-team',
    title: 'Agent Teams coordination domain',
    mode: 'core',
    consumers: ['experimental-tool-agent-team'],
    note: 'Owns the implicit-root roster, direct peer inbox delivery, shared task DAG, and continuable-child lifecycle; tool-agent-team contributes model controls.',
  },
  {
    key: 'claudeCodeMods',
    pkg: 'experimental-claude-code-mods',
    title: 'Claude Code mods bridge',
    mode: 'core',
    note: 'Loads mods that defineMod plugins add, raises their hook chains from harness extension points, and draws the band above the prompt over its Remote.',
  },
  {
    key: 'inspector',
    pkg: 'inspector',
    title: 'Cross-realm runtime inspection',
    mode: 'core',
    note: 'Owns the Worker-hosted CDP target and the transport-independent Host and Client observation and Cordis-tree query API.',
  },
  {
    key: 'jobs',
    pkg: 'jobs',
    title: 'Background job registry',
    mode: 'seam',
    implementations: ['jobs-local'],
    consumers: ['tool-bash', 'tool-pwsh', 'tool-terminal', 'tool-jobs', 'api-job-controller'],
    note: 'Producers (background bash/pwsh and PTY sends) register running work; record-declaring jobs additionally stream raw output for non-consuming observers; tool-jobs is the model-facing controller that reads, lists, and kills it; jobs-local is the process-local registry.',
  },
  {
    key: 'web',
    pkg: 'web',
    title: 'Web access provider registry',
    mode: 'seam',
    implementations: ['web-search-exa', 'web-search-perplexity', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http'],
    consumers: ['tool-web'],
    note: 'Search and fetch providers register into one ctx.web seam; tool-web owns the stable model-facing names.',
  },
  {
    key: 'spillStore',
    pkg: 'spill',
    title: 'Spill storage seam',
    mode: 'seam',
    implementations: ['spill-local'],
    consumers: ['spill-policy'],
    note: 'The backend saves oversized tool text and returns a model-facing locator plus retrieval hint; spill-policy is the tools/post-execute consumer that decides when to spill.',
  },
  {
    key: 'directoryPicker',
    pkg: 'host-directory-picker',
    title: 'Workspace-directory picking seam',
    mode: 'seam',
    implementations: ['host-directory-picker-native', 'host-directory-picker-browse'],
    consumers: ['api-workspace-controller'],
    note: 'Discriminated interaction capability: the native backend opens one OS chooser on the host display, the browse backend serves listing/creation primitives for the in-app browser; dual-face backends fill ui-workspace directory-flow slots from their browser halves (no wire advertisement).',
  },
  {
    key: 'webServer',
    pkg: 'host-webserver',
    title: 'HTTP route registration',
    mode: 'core',
    consumers: ['client-connection', 'client-modules', 'client-hmr'],
    note: 'Plain node:http carrier: named-route registry, index transform taps, and the static dist fallback; web-transport plugins register their own routes.',
  },
  {
    key: 'webApp',
    pkg: 'web-app',
    title: 'Served Web GUI',
    mode: 'core',
    consumers: ['harness-dev-context'],
    note: 'The web-runtime row advertises one URL for its Web GUI: the configured publicUrl, otherwise the listener origin; DSH_WEB_URL, the startup URL, and harness-dev-context read the same value.',
  },
  {
    key: 'clientModules',
    pkg: 'client-modules',
    title: 'Client plugin graph host',
    mode: 'core',
    consumers: ['client-hmr'],
    note: 'Composes the __DSH_BOOT__ entry graph from an incremental dsh.client scan, serves plugin bundles, and notifies rebuilt/graph-changed subscribers.',
  },
  {
    key: 'workflowEngine',
    pkg: 'workflow',
    title: 'Workflow script engine',
    mode: 'seam',
    implementations: ['workflow-ptc'],
    consumers: ['tool-workflow', 'tool-ralph'],
    note: 'One engine per context, as in bash, with no named-provider registry; the general workflow and fixed Ralph consumers start runs whose agent() calls fan out through ctx.subagents.',
  },
  {
    key: 'webhookRuntime',
    pkg: 'webhook',
    title: 'Webhook rule runtime',
    mode: 'core',
    consumers: ['webhook-github'],
    note: 'Provider adapters dispatch authenticated deliveries; trusted plugins register independent process-local rules, and the runtime turns non-null results into ordinary Workspace-backed Sessions without delivery or completion state.',
  },
  {
    key: 'lsp',
    pkg: 'lsp',
    title: 'Language-server navigation seam',
    mode: 'seam',
    implementations: ['lsp-stdio'],
    consumers: ['tool-lsp'],
    note: 'Provider registration and selection plus normalized query execution over exactly four operations; the seam offers no protocol escape hatch, so a backend translates into the normalized request and result.',
  },
  {
    key: 'dynamicCordisRunner',
    pkg: 'cordis-host-runner',
    title: 'Dynamic Cordis package host runner',
    mode: 'core',
    consumers: ['tool-cordis'],
    note: 'Owns the in-memory definition registry, the vm sandbox for host halves, and the request-run round trip; browser pages reach the same service over the wire through its remote namespace.',
  },
  {
    key: 'cordisInspect',
    pkg: 'cordis-host-runner',
    title: 'Dynamic Cordis inspect registry',
    mode: 'core',
    consumers: ['tool-cordis'],
    note: 'Registers host inspect providers, mirrors the client provider manifest, and routes client queries through the dynamic Cordis transport.',
  },
  {
    key: 'liveshareShares',
    pkg: 'experimental-liveshare',
    title: 'Owner share management Remote',
    mode: 'service',
    note: 'Publishes the owner share-management operations as one Typert Remote namespace that the owner client face calls; every method delegates to the same operations the same-origin routes used.',
  },
]

function generatedHeader(title: string): string[] {
  return [
    '<!-- Generated by scripts/gen-doc-graphs.ts - do not edit by hand.',
    '     Run `pnpm run gen-doc-graphs` to regenerate. -->',
    '',
    `# ${title}`,
    '',
  ]
}

function maintenanceFooter(source: string): string[] {
  return [`Maintenance mode: ${source}.`, '']
}

function graphIndexLink(rel: string): string {
  return relative('docs', rel).replaceAll('\\', '/')
}

function linkFromDoc(docRel: string, targetRel: string): string {
  return relative(dirname(docRel), targetRel).replaceAll('\\', '/')
}

function mermaidCode(value: string): string {
  return `<code>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`
}

function repoLink(path: string, label: string, up = '..'): string {
  return `[${label}](${up}/${path})`
}

function sourceLink(source: string, up = '..'): string {
  return repoLink(source.split(':')[0] ?? source, `\`${source}\``, up)
}

function pkgLink(pkg: Pkg | undefined, fallback: string, up = '..'): string {
  return pkg ? repoLink(pkg.rel, `\`${pkg.short}\``, up) : `\`${fallback}\``
}

function pkgList(names: string[] | undefined, pkgsByShort: Map<string, Pkg>): string {
  if (!names || names.length === 0) return '-'
  return names.map(name => pkgLink(pkgsByShort.get(name), name)).join(', ')
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function assertServiceRolesComplete(services: readonly ServiceEntry[]): void {
  const discovered = new Set(services.map(service => service.key))
  const classified = new Set(SERVICE_ROLES.map(role => role.key))
  const missing = [...discovered].filter(key => !classified.has(key)).sort()
  const stale = [...classified].filter(key => !discovered.has(key)).sort()
  if (missing.length || stale.length) {
    throw new Error([
      missing.length ? `missing service role classification: ${missing.join(', ')}` : '',
      stale.length ? `stale service role classification: ${stale.join(', ')}` : '',
    ].filter(Boolean).join('; '))
  }
}

function renderCapabilitySeams(pkgs: Pkg[], services: readonly ServiceEntry[]): string {
  assertServiceRolesComplete(services)
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const maintenance = 'hybrid: services are discovered from Cordis declarations; interface/implementation/consumer roles are classified in `scripts/gen-doc-graphs.ts` with a completeness guard'
  const nodes = new Map<string, string>()
  const edges = new Set<string>()
  const companionEdges = new Set<string>()
  const addNode = (id: string, label: string): void => {
    if (!nodes.has(id)) nodes.set(id, `  ${id}["${escLabel(label)}"]`)
  }
  const addEdge = (from: string, to: string): void => { edges.add(`  ${from} --> ${to}`) }
  const lines = generatedHeader('Capability Seams And Core Services')
  lines.push(
    'A service can be a core spine service, a swappable capability seam, a bundle/composition point, or a standalone service. The graph shows the package that owns the service declaration, known implementation packages, and packages that consume the service directly.',
    '',
    '```mermaid',
    'flowchart LR',
  )
  for (const role of SERVICE_ROLES) {
    const svc = nodeId('svc', role.key)
    const owner = nodeId('pkg', role.pkg)
    addNode(owner, role.pkg)
    addNode(svc, `ctx.${role.key}<br/>${role.title}`)
    addEdge(owner, svc)
    for (const impl of role.implementations ?? []) {
      addNode(nodeId('pkg', impl), impl)
      addEdge(nodeId('pkg', impl), svc)
    }
    for (const consumer of role.consumers ?? []) {
      addNode(nodeId('pkg', consumer), consumer)
      addEdge(svc, nodeId('pkg', consumer))
    }
    for (const companion of role.companions ?? []) {
      addNode(nodeId('pkg', companion), companion)
      companionEdges.add(`  ${svc} -. event gate .-> ${nodeId('pkg', companion)}`)
    }
  }
  lines.push(...nodes.values(), ...[...edges].sort(), ...[...companionEdges].sort())
  lines.push('```', '', '| ctx key | Role | Owner | Implementations | Direct consumers | Companion plugins | Note |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const role of SERVICE_ROLES) {
    lines.push(`| \`ctx.${role.key}\` | \`${role.mode}\` | ${pkgLink(pkgsByShort.get(role.pkg), role.pkg)} | ${pkgList(role.implementations, pkgsByShort)} | ${pkgList(role.consumers, pkgsByShort)} | ${pkgList(role.companions, pkgsByShort)} | ${tableCell(role.note)} |`)
  }
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

function parseExampleCordis(rel: string): ExamplePlugin[] {
  const text = readFileSync(resolve(root, rel), 'utf8')
  const plugins: ExamplePlugin[] = []
  let current: { id: string; name?: string } | null = null
  const flush = (): void => {
    if (current?.name) plugins.push({ id: current.id, name: current.name })
  }
  for (const line of text.split('\n')) {
    // Top-level rows (`- id:`) and bundle-patch insert rows (`    - id:`).
    const id = /^\s*-\s+id:\s+(.+?)\s*$/.exec(line)
    if (id?.[1] !== undefined) {
      flush()
      current = { id: stripYamlScalar(id[1]) }
      continue
    }
    const name = /^\s+name:\s+(.+?)\s*$/.exec(line)
    if (name?.[1] !== undefined && current) current.name = stripYamlScalar(name[1])
  }
  flush()
  return plugins
}

function stripYamlScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

const APP_EXAMPLES = [
  {
    id: 'dsh_base',
    rel: 'apps/cli/composition.md',
    title: 'DSH Base Composition',
    label: 'packages/bundle/base/cordis.patch.yml',
    config: 'packages/bundle/base/cordis.patch.yml',
    summary: 'The dsh-base bundle patch shared by the web, headless, sdk, and acp profiles; their mode bundles and user layers patch over it, while sdk-minimal owns a separate standalone tree.',
  },
]

type AppExample = typeof APP_EXAMPLES[number]

function renderAppComposition(example: AppExample): string {
  const plugins = parseExampleCordis(example.config)
  const maintenance = 'hybrid: the patch row list is parsed from its `cordis.yml`; app package expansion is curated from package source'
  const lines = generatedHeader(example.title)
  lines.push(
    example.summary,
    '',
    '```mermaid',
    'flowchart LR',
    `  cfg["${escLabel(example.label)}<br/>cordis.yml"]`,
  )
  for (const plugin of plugins) {
    const pluginNode = nodeId(`plugin_${example.id}`, plugin.id)
    lines.push(`  ${pluginNode}["${escLabel(plugin.id)}<br/>${escLabel(plugin.name)}"]`)
    lines.push(`  cfg --> ${pluginNode}`)
  }
  lines.push(
    '```',
    '',
    '| Plugin id | Package / module |',
    '| --- | --- |',
    ...plugins.map(plugin => `| \`${plugin.id}\` | \`${plugin.name}\` |`),
    '',
    `Source config: [\`${example.config}\`](${linkFromDoc(example.rel, example.config)}).`,
  )
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

type CallSiteIndex = Map<ts.SignatureDeclaration | ts.JSDocSignature, ts.CallExpression[]>

/**
 * The only method names visitSource classifies; receiver typing runs on these
 * alone. Obligation: every method name matched by a branch inside visitSource
 * must appear here — the prefilter drops non-members before any branch runs,
 * so a branch for an unlisted name is silently dead.
 */
const EVENT_API_METHODS = new Set(['on', 'once', 'emit', 'parallel', 'serial', 'waterfall', 'dispatch'])

/**
 * Collect event dispatch/listener relations from real cross-file receiver types.
 *
 * TODO: the program is seeded from the host aggregate alone (ts-project.ts
 * documents why: one program cannot hold both faces' Context merges), so a
 * Client package enters only when a host file imports it. Client-face
 * listeners on client-face events are therefore under-reported —
   * `connection/reset` omits `ui-skill`/`ui-agent-preset`. Closing it needs a
   * second Client program whose relations merge into these, not a wider seed.
 */
export class EventRelationCollector {
  private readonly relations = new Map<string, EventRelation>()
  private readonly fileCallSites = new Map<ts.SourceFile, CallSiteIndex>()
  private readonly localCalleeProofs = new Map<ts.FunctionDeclaration, boolean>()
  private globalCallSites: CallSiteIndex | null = null
  private readonly contextType: ts.Type
  private readonly agentDispatchType: ts.Type
  private readonly eventsServiceType: ts.Type
  private readonly packageSourceFiles: ReadonlySet<ts.SourceFile>

  constructor(
    private readonly project: TypeScriptProject,
    private readonly sources: readonly PackageSource[],
  ) {
    this.contextType = this.declaredType('vendor/cordis/src/context.ts', 'Context')
    this.agentDispatchType = this.declaredType('packages/core/agent/src/dispatch.ts', 'AgentEventDispatch')
    this.eventsServiceType = this.declaredType('vendor/cordis/src/events.ts', 'EventsService')
    this.packageSourceFiles = new Set(sources.map(source => source.sourceFile))
  }

  /** Return all event relations discovered from the Program. */
  collect(): Map<string, EventRelation> {
    for (const source of this.sources) this.visitSource(source)
    return this.relations
  }

  /** Resolve one named class/interface declaration to its merged instance type. */
  private declaredType(relativePath: string, name: string): ts.Type {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration | ts.InterfaceDeclaration => {
      return (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name?.text === name
    })
    const symbol = declaration?.name && this.project.checker.getSymbolAtLocation(declaration.name)
    if (!symbol) throw new Error(`cannot resolve TypeScript type ${name} from ${relativePath}`)
    return this.project.checker.getDeclaredTypeOfSymbol(symbol)
  }

  /** Index resolved function calls in the given files for narrow argument-flow recovery. */
  private buildCallSiteIndex(files: Iterable<ts.SourceFile>): CallSiteIndex {
    const index: CallSiteIndex = new Map()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = this.project.checker.getResolvedSignature(node)?.declaration
        if (declaration) {
          const calls = index.get(declaration) ?? []
          calls.push(node)
          index.set(declaration, calls)
        }
      }
      ts.forEachChild(node, visit)
    }
    for (const file of files) visit(file)
    return index
  }

  /**
   * Return every indexed call resolving to one local helper declaration.
   * Fast path: when every same-file reference to the non-exported helper is
   * provably a direct callee, module scoping confines all of its calls to that
   * file, so only that file is indexed. Any other reference form may alias
   * the function value outward, so the original full package-source index
   * decides instead.
   */
  private callSitesFor(owner: ts.FunctionDeclaration): ts.CallExpression[] {
    if (!this.globalCallSites && !this.provenLocalCallee(owner)) {
      this.globalCallSites = this.buildCallSiteIndex(this.packageSourceFiles)
    }
    if (this.globalCallSites) return this.globalCallSites.get(owner) ?? []
    const file = owner.getSourceFile()
    let index = this.fileCallSites.get(file)
    if (!index) {
      index = this.buildCallSiteIndex([file])
      this.fileCallSites.set(file, index)
    }
    return index.get(owner) ?? []
  }

  /**
   * Prove every same-file reference to one helper is a direct callee. The
   * proof owns its premises: an exported helper or a helper in a global
   * script file (no import/export means program-wide scope, callable from
   * another file with no same-file reference at all) fails immediately.
   * Alias escapes (re-export statements, default exports, value reads)
   * resolve back to the owner symbol at a non-callee position and fail the
   * proof, as does anything the scan cannot positively classify.
   */
  private provenLocalCallee(owner: ts.FunctionDeclaration): boolean {
    const cached = this.localCalleeProofs.get(owner)
    if (cached !== undefined) return cached
    if (hasExportModifier(owner) || !ts.isExternalModule(owner.getSourceFile())) {
      this.localCalleeProofs.set(owner, false)
      return false
    }
    const name = owner.name
    const ownerSymbol = name && this.project.checker.getSymbolAtLocation(name)
    let proven = !!ownerSymbol
    const refersToOwner = (identifier: ts.Identifier): boolean => {
      // Shorthand properties resolve to the property symbol; ask for the value side.
      const local = ts.isShorthandPropertyAssignment(identifier.parent)
        ? this.project.checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : this.project.checker.getSymbolAtLocation(identifier)
      if (!local) return false
      const symbol = local.flags & ts.SymbolFlags.Alias
        ? this.project.checker.getAliasedSymbol(local)
        : local
      return symbol === ownerSymbol
    }
    const visit = (node: ts.Node): void => {
      if (!proven) return
      if (ts.isIdentifier(node) && node !== name && node.text === name?.text
        && !isDirectCallee(node) && refersToOwner(node)) {
        proven = false
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(owner.getSourceFile())
    this.localCalleeProofs.set(owner, proven)
    return proven
  }

  /** Walk one package source file and classify event API calls by receiver type. */
  private visitSource(source: PackageSource): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (this.isAgentEventEmitter(node.expression)) {
          const event = node.arguments[2]
          if (event) {
            for (const name of this.finiteStringValues(event) ?? []) {
              this.addDispatcher(name, source.pkg, 'emitAgentEvent')
            }
          }
        } else if (ts.isPropertyAccessExpression(node.expression) && EVENT_API_METHODS.has(node.expression.name.text)) {
          const receiverKind = this.receiverKind(node.expression.expression)
          const method = node.expression.name.text
          if (receiverKind === 'events-service' && method === 'dispatch') {
            const argumentList = node.arguments[1]
            if (argumentList) {
              for (const event of this.eventNamesFromArgumentList(argumentList, new Set())) {
                this.addDispatcher(event, source.pkg, 'events.dispatch')
              }
            }
          } else if (receiverKind === 'context' || receiverKind === 'agent-dispatch') {
            const eventNames = this.eventNamesFromCall(node, receiverKind)
            if (method === 'on' || method === 'once') {
              for (const event of eventNames) this.ensure(event).listeners.add(source.pkg)
            } else if (method === 'emit' || method === 'parallel' || method === 'serial' || method === 'waterfall') {
              for (const event of eventNames) this.addDispatcher(event, source.pkg, method)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source.sourceFile)
  }

  /** Match the exported contained-notification helper by declaration identity. */
  private isAgentEventEmitter(expression: ts.Expression): boolean {
    if (!ts.isIdentifier(expression)) return false
    const local = this.project.checker.getSymbolAtLocation(expression)
    if (!local) return false
    const symbol = local.flags & ts.SymbolFlags.Alias
      ? this.project.checker.getAliasedSymbol(local)
      : local
    const declarations = symbol.declarations ?? []
    return declarations.some((declaration) => {
      return ts.isFunctionDeclaration(declaration)
        && declaration.name?.text === 'emitAgentEvent'
        && this.project.relativePath(declaration.getSourceFile()) === 'packages/core/agent/src/dispatch.ts'
    })
  }

  /** Classify a receiver using assignability to the repository's actual event API types. */
  private receiverKind(receiver: ts.Expression): EventReceiverKind | undefined {
    const type = this.project.checker.getTypeAtLocation(receiver)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return undefined
    if (this.project.checker.isTypeAssignableTo(type, this.eventsServiceType)) return 'events-service'
    if (this.project.checker.isTypeAssignableTo(type, this.contextType)) return 'context'
    if (this.project.checker.isTypeAssignableTo(type, this.agentDispatchType)) return 'agent-dispatch'
    return undefined
  }

  /** Resolve the event-name argument for Context and fused agent dispatch calls. */
  private eventNamesFromCall(call: ts.CallExpression, receiverKind: Exclude<EventReceiverKind, 'events-service'>): Set<string> {
    const candidates = receiverKind === 'context' ? call.arguments.slice(0, 2) : call.arguments.slice(0, 1)
    for (const candidate of candidates) {
      const values = this.finiteStringValues(candidate)
      if (values) return values
    }
    return new Set()
  }

  /** Recover the event slot from the argument array handed to EventsService.dispatch(). */
  private eventNamesFromArgumentList(expression: ts.Expression, seen: Set<ts.Node>): Set<string> {
    const current = unwrapExpression(expression)
    if (seen.has(current)) return new Set()
    seen.add(current)

    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements.slice(0, 2)) {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) continue
        const values = this.finiteStringValues(element)
        if (values) return values
      }
      return new Set()
    }
    if (ts.isConditionalExpression(current)) {
      return unionSets(
        this.eventNamesFromArgumentList(current.whenTrue, new Set(seen)),
        this.eventNamesFromArgumentList(current.whenFalse, new Set(seen)),
      )
    }
    if (!ts.isIdentifier(current)) return new Set()

    const symbol = this.project.checker.getSymbolAtLocation(current)
    if (!symbol) return new Set()
    const events = new Set<string>()
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && isConstDeclaration(declaration)) {
        addAll(events, this.eventNamesFromArgumentList(declaration.initializer, new Set(seen)))
      } else if (ts.isParameter(declaration)) {
        addAll(events, this.eventNamesFromParameter(declaration, seen))
      }
    }
    return events
  }

  /** Follow a non-exported local helper parameter back to every resolved call site. */
  private eventNamesFromParameter(parameter: ts.ParameterDeclaration, seen: Set<ts.Node>): Set<string> {
    const owner = parameter.parent
    if (!ts.isFunctionDeclaration(owner) || hasExportModifier(owner)) return new Set()
    const index = owner.parameters.indexOf(parameter)
    if (index < 0) return new Set()
    const events = new Set<string>()
    for (const call of this.callSitesFor(owner)) {
      const argument = call.arguments[index]
      if (argument) addAll(events, this.eventNamesFromArgumentList(argument, new Set(seen)))
    }
    return events
  }

  /** Return a finite string-literal value set, rejecting widened and generic strings. */
  private finiteStringValues(expression: ts.Expression): Set<string> | undefined {
    const current = unwrapExpression(expression)
    if (ts.isStringLiteralLike(current)) return new Set([current.text])
    if (this.isForwardedAgentEventParameter(current)) return undefined
    return finiteStringTypeValues(this.project.checker.getTypeAtLocation(current))
  }

  /** Reject the contextual parameter inside the AgentEventDispatch forwarding object. */
  private isForwardedAgentEventParameter(expression: ts.Expression): boolean {
    if (!ts.isIdentifier(expression)) return false
    const declarations = this.project.checker.getSymbolAtLocation(expression)?.declarations ?? []
    return declarations.some((declaration) => {
      if (!ts.isParameter(declaration)) return false
      const method = declaration.parent
      if (!ts.isMethodDeclaration(method) || !ts.isObjectLiteralExpression(method.parent)) return false
      const contextualType = this.project.checker.getContextualType(method.parent)
      return contextualType !== undefined
        && this.project.checker.isTypeAssignableTo(contextualType, this.agentDispatchType)
    })
  }

  /** Get or create one relation row. */
  private ensure(event: string): EventRelation {
    const existing = this.relations.get(event)
    if (existing) return existing
    const relation = { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    this.relations.set(event, relation)
    return relation
  }

  /** Add one dispatcher method without duplicating package/method labels. */
  private addDispatcher(event: string, pkg: string, method: string): void {
    const relation = this.ensure(event)
    const methods = relation.dispatchers.get(pkg) ?? new Set<string>()
    methods.add(method)
    relation.dispatchers.set(pkg, methods)
  }
}

/** Return whether an identifier is the callee of a call, seen through value-preserving wrappers. */
function isDirectCallee(identifier: ts.Identifier): boolean {
  let current: ts.Node = identifier
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
  ) {
    current = current.parent
  }
  return ts.isCallExpression(current.parent) && current.parent.expression === current
}

/** Peel syntax-only wrappers that do not change an expression's runtime value. */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** Return every value only when a type is a closed string-literal union. */
function finiteStringTypeValues(type: ts.Type): Set<string> | undefined {
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return new Set([(type as ts.StringLiteralType).value])
  }
  if (type.flags & ts.TypeFlags.Never) return new Set()
  if (!type.isUnion()) return undefined
  const values = new Set<string>()
  for (const member of type.types) {
    const memberValues = finiteStringTypeValues(member)
    if (!memberValues) return undefined
    addAll(values, memberValues)
  }
  return values
}

/** Return whether a variable declaration belongs to a const declaration list. */
function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (declaration.parent.flags & ts.NodeFlags.Const) !== 0
}

/** Return whether a declaration is visible to callers outside its source module. */
function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => {
    return modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
  }) ?? false)
}

/** Add every member of source to target. */
function addAll<T>(target: Set<T>, source: ReadonlySet<T>): void {
  for (const value of source) target.add(value)
}

/** Return the union of two sets without mutating either input. */
function unionSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> {
  const out = new Set(left)
  addAll(out, right)
  return out
}

/**
 * Select the package source files of one project in deterministic order.
 * @param project - the loaded repository TypeScript project.
 * @returns `packages/<group>/<pkg>/src` files tagged with their package name.
 */
export function collectPackageSources(project: TypeScriptProject): PackageSource[] {
  return project.sourceFiles().flatMap((sourceFile): PackageSource[] => {
    const rel = project.relativePath(sourceFile)
    const match = /^packages\/[^/]+\/([^/]+)\/src\/.+\.ts$/.exec(rel)
    return match?.[1] ? [{ rel, pkg: match[1], sourceFile }] : []
  }).sort((left, right) => left.rel.localeCompare(right.rel))
}

function collectEventRelations(): Map<string, EventRelation> {
  const project = new TypeScriptProject(root)
  return new EventRelationCollector(project, collectPackageSources(project)).collect()
}

function relationPackages(map: Map<string, Set<string>>, pkgsByShort: Map<string, Pkg>): string {
  if (map.size === 0) return '-'
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, methods]) => `${pkgLink(pkgsByShort.get(pkg), pkg)} (${[...methods].sort().map(m => `\`${m}\``).join(', ')})`)
    .join(', ')
}

function listenerPackages(listeners: Set<string>, pkgsByShort: Map<string, Pkg>): string {
  if (listeners.size === 0) return '-'
  return [...listeners].sort().map(pkg => pkgLink(pkgsByShort.get(pkg), pkg)).join(', ')
}

function renderEventRelations(pkgs: Pkg[], events: readonly EventEntry[]): string {
  const relations = collectEventRelations()
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const maintenance = 'generated: Cordis event declarations and producer/listener edges are resolved from the repository TypeScript Program'
  const lines = generatedHeader('Event Producer And Consumer Matrix')
  lines.push(
    'This matrix shows which packages dispatch each harness-owned event and which packages listen to it. Events are many-to-many, so the dense relation data is presented as a table rather than one large graph. Receiver and event-name types also cover contained dispatch sites that deliberately bypass `ctx.emit`, such as subagent lifecycle containment.',
    '',
    'Application listeners are outside this package matrix. Desktop Host subscribes to `plugin-manager/operation` through [`installOperationDiagnostics`](../apps/desktop-host/src/operation-diagnostics.ts) and forwards bounded records to the shell.',
    '',
  )
  const rows = ['| Event | Mode | Declared in | Dispatchers | Listeners |', '| --- | --- | --- | --- | --- |']
  for (const event of [...events].sort((a, b) => a.name.localeCompare(b.name))) {
    const relation = relations.get(event.name) ?? { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    rows.push(`| \`${event.name}\` | \`${event.mode}\` | ${sourceLink(event.source)} | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
  }
  lines.push(renderGeneratedRegion('event-producer-consumer:events', rows.join('\n')))
  // Every declared event needs a dispatcher: zero means dead vocabulary or an
  // unrecognized semantic dispatch form. Listener-free extension points remain
  // valid. Client-declared events are exempt: the relation scan seeds the HOST
  // aggregate program only (host+client cannot share one program — the cordis
  // Context merges collide), so client dispatch sites are structurally
  // invisible here; their rows stay in the table for the declarations' sake.
  const undispatched = [...events]
    .filter(event => !event.source.startsWith('packages/client/'))
    .filter(event => (relations.get(event.name)?.dispatchers.size ?? 0) === 0)
    .map(event => event.name)
    .sort()
  if (undispatched.length > 0) {
    throw new Error(
      `event-producer-consumer matrix: no dispatcher found for declared event${undispatched.length > 1 ? 's' : ''} `
      + `${undispatched.map(name => `"${name}"`).join(', ')} — dead vocabulary, or a dispatch form the semantic scan misses `
      + '(teach scripts/gen-doc-graphs.ts that form)',
    )
  }
  const declared = new Set(events.map(event => event.name))
  const extra = [...relations.keys()].filter(event => !declared.has(event)).sort()
  if (extra.length > 0) {
    const extraRows = ['| Event string | Dispatchers | Listeners |', '| --- | --- | --- |']
    for (const event of extra) {
      const relation = relations.get(event)
      if (!relation) continue
      extraRows.push(`| \`${event}\` | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
    }
    lines.push(
      '',
      '## Non-harness or undeclared event strings seen in package source',
      '',
      renderGeneratedRegion('event-producer-consumer:undeclared', extraRows.join('\n')),
    )
  }
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

function renderLifecycle(): string {
  const maintenance = 'curated Mermaid sequence; exact event signatures live in the generated Cordis catalog'
  return [
    ...generatedHeader('Agent Turn And Step Lifecycle'),
    'This sequence is the visual companion to [architecture.md](architecture.md#turn-flow). It keeps durable replay facts on `session/event` and live control/status on `agent/*`.',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Agent',
    '  participant Driver',
    '  participant Hooks as hook listeners',
    '  participant Prompt as ctx.systemPrompt',
    '  participant LLM as ctx.llm',
    '  participant Tools as ctx.tools',
    '  participant Session',
    '  participant SDK as UI or SDK listener',
    '  User->>Agent: followup(content)',
    `  Agent-->>SDK: ${mermaidCode('agent/inbox/spliced')}`,
    `  Agent-->>SDK: ${mermaidCode('agent/inbox/inserted')} { message }`,
    '  Agent->>Driver: queued work wakes driver',
    `  Driver-->>SDK: ${mermaidCode('agent/status')} running`,
    `  Driver->>Session: ${mermaidCode('turn/start')}`,
    '  Note over Agent,Driver: claim pending next-step input plus one queued prompt',
    `  Driver-->>SDK: ${mermaidCode('agent/inbox/spliced')} pure deletion`,
    `  Driver-->>SDK: ${mermaidCode('agent/inbox/claimed')} { message, turn } per message`,
    '  Driver->>Tools: resolve({ agent, modelSelection, signal }) once per proposed step',
    `  Driver->>Prompt: ${mermaidCode('system-prompt/assemble')} waterfall with the step tool set`,
    `  Driver->>Hooks: ${mermaidCode('agent/pre-step')} waterfall`,
    '  Hooks-->>Driver: authoritative reject or enter(messages)',
    '  alt proposed step rejected, first batch empty, or pre-step failed',
    '    Driver-->>Driver: claimed batch stays removed, the open turn spends no step',
    '  else enter proposed step',
    `  Driver->>Session: ${mermaidCode('step/start')}`,
    `  Driver->>Hooks: ${mermaidCode('agent/request')} waterfall`,
    '  Driver->>LLM: prepareCall(config, signal)',
    '  Note over Driver,LLM: cancellation during either async phase commits neither system nor users',
    '  Note over Driver,Session: synchronous admission using the prepared call capability',
    `  Driver->>Session: ${mermaidCode('system/message')} ordered per-node reconciliation`,
    `  Driver->>Session: ${mermaidCode('user/message')} per entered message`,
    `  Driver->>Session: ${mermaidCode('request/header')} and ${mermaidCode('request/context')} as needed`,
    '  Driver->>Driver: derive and freeze request from the log',
    `  Driver->>LLM: bound prepared call through ${mermaidCode('llm/stream')} waterfall`,
    '  LLM-->>Driver: StreamChunk*',
    `  Driver-->>SDK: ${mermaidCode('agent/assistant-stream')} chunk*`,
    '  alt final adapter or terminal in-band request failure',
    `    Driver->>Session: ${mermaidCode('assistant/attempt')}`,
    `    Driver-->>SDK: ${mermaidCode('agent/assistant-stream')} committed end`,
    `    Driver->>Hooks: ${mermaidCode('agent/request-error')} waterfall`,
    '    Hooks-->>Driver: return retry action or preserve the original error',
    '    Note over Driver,LLM: retry in the open step: prepare and reconcile the same rendered assembly without repeating pre-step or users',
    '  else model request succeeded',
    `  Driver->>Session: ${mermaidCode('assistant/message')}`,
    `  Driver-->>SDK: ${mermaidCode('agent/assistant-stream')} committed end`,
    '  Driver->>Tools: classify pending call by executionMode',
    '  loop barriers and bounded rolling pool, reclassify before start',
    '    opt call starts',
    `      Driver->>Session: ${mermaidCode('tool/call')}`,
    '      Driver->>Tools: ordered pre, concurrent execute',
    '      Tools-->>Session: tool-owned events when applicable',
    '    end',
    '    opt next model-order result ready',
    '      Driver->>Tools: ordered post',
    `      Driver->>Session: ${mermaidCode('tool/result')}`,
    '    end',
    '  end',
    `  Driver->>Session: ${mermaidCode('step/end')}`,
    '  Driver->>Tools: dispose the step tool set',
    '  opt natural stop and next-step inbox empty',
    `    Driver->>Hooks: ${mermaidCode('agent/turn-stopping')} serial terminal checkpoint`,
    '  end',
    '  opt next-step input is pending',
    '    Driver-->>Driver: claim pending next-step input',
    `    Driver-->>SDK: ${mermaidCode('agent/inbox/claimed')} { message, turn } per message`,
    `    Driver->>Hooks: ${mermaidCode('agent/pre-step')} waterfall`,
    '    Hooks-->>Driver: authoritative reject or enter(messages)',
    '  end',
    '  end',
    '  end',
    `  Driver->>Session: ${mermaidCode('turn/end')}`,
    `  Driver-->>SDK: ${mermaidCode('agent/status')} idle`,
    '```',
    '',
    'The `assistant/message` event records every successful provider call, including content-less and `max-tokens` finishes, and embeds the exact compact timed stream. Empty content stays out of derived history. A failed, retried, cancelled, or stream-error attempt that reaches settlement without a surface message records its stream as `assistant/attempt`. Live `agent/assistant-stream` chunk frames are transient; replay reads either durable settlement, and a hard process loss before settlement leaves no durable attempt stream.',
    '',
    '`dsh-compaction-basic` uses `agent/pre-step` for pressure before request derivation and `agent/request-error` only for canonical context overflow. Once either trigger qualifies, optional tool-result pruning runs before summary selection. Recovery runs within the open step and retries only when pruning or summarization advances the surface replacement generation; otherwise the original request error remains authoritative. Each retry prepares its call and reconciles the retained rendered assembly before request derivation, without repeating assembly, pre-step, or user admission.',
    '',
    'The returned `agent/pre-step` decision is authoritative; listeners wrapping `next()` preserve downstream messages and `startsRequestSeries` unless replacement is intentional. Steering and injected context pass through the same waterfall after a later claim operation takes their next-step batch.',
    '',
    'SDK users that need replayable transcript data should consume `session/event`; `agent/*` is the live coordination API for queue/status, prompt interception, request construction, steering, continuation, and errors.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderToolPipeline(): string {
  const maintenance = 'curated Mermaid flow; exact tool schemas and event signatures live in generated catalogs'
  return [
    ...generatedHeader('Tool Execution Pipeline'),
    'Built-in executors own raw batch parsing, scheduling, cancellation, and Session call/result logging. This graph shows where their shared invocation pipeline applies policy, hooks, sandboxing, filesystem guards, result rewriting, final-outcome observation, and UI rendering without changing the loop. The `tools/pre-execute` waterfall runs first, monotonic guards run next, and the `tools/execute` and `tools/post-execute` waterfalls follow; the three waterfalls may transform a call. Definition-owned `projectContent` installs prepared content before post-execute; `finalizeContent` and `tools/result` run afterward.',
    '',
    '```mermaid',
    'flowchart TD',
    '  model["Assistant message contains tool-call block"]',
    `  toolCall["Session event: ${mermaidCode('tool/call')}<br/>logged before execution"]`,
    '  presentCall["UI pending card<br/>presentCall(args)"]',
    `  pre["${mermaidCode('tools/pre-execute')} waterfall<br/>hooks, permission, sandbox"]`,
    '  guards["Registered monotonic guards<br/>deny or abstain; identity protected"]',
    '  denied["denied or approval refused<br/>tool body skipped"]',
    `  approval["${mermaidCode('ctx.approval')} one-shot prompt<br/>absent or unanswerable: deny"]`,
    `  around["${mermaidCode('tools/execute')} waterfall<br/>timeout, retry, metrics (around dispatch)"]`,
    '  toolBody["Registered tool execute() body"]',
    `  fsGate["${mermaidCode('fs/write-intent')} or ${mermaidCode('fs/edit-intent')}<br/>tool-fs mutations only"]`,
    `  owned["Tool-owned session events<br/>${mermaidCode('todo/write')}, ${mermaidCode('fs/observed')}, ${mermaidCode('hook/invoked')}, ${mermaidCode('hook/result')}, ${mermaidCode('tool/ptc-dispatch')}"]`,
    '  project["ToolDefinition.projectContent<br/>execution-prepared text and images"]',
    `  post["${mermaidCode('tools/post-execute')} waterfall<br/>accept, block, replace, add context"]`,
    '  normalized["Invocation pipeline normalization<br/>pipeline/result snapshot throws become isError"]',
    '  finalize["ToolDefinition.finalizeContent<br/>last content-only invariant"]',
    `  final["${mermaidCode('tools/result')} synchronous notification<br/>frozen authoritative outcome"]`,
    '  context["Active-batch additionalContexts FIFO<br/>injected user/message after recorded tool results"]',
    `  toolResult["Session event: ${mermaidCode('tool/result')}<br/>single model-facing outcome"]`,
    '  allResults["Tool batch settled<br/>recorded tool/result events complete"]',
    '  presentResult["UI completed card<br/>presentResult(args, result)"]',
    '  executor["Selected ToolExecutor.execute<br/>raw batch, Agent, optional logging step"]',
    '  model --> executor --> toolCall',
    '  toolCall --> presentCall',
    '  toolCall --> pre',
    '  pre -->|allow| guards',
    '  guards -->|allow| around',
    '  guards -->|deny| denied',
    '  guards -.->|throw| normalized',
    '  around --> toolBody',
    '  pre -->|deny| denied',
    '  pre -->|ask| approval',
    '  approval -->|allowed-once| guards',
    '  approval -->|rejected, cancelled, unavailable| denied',
    '  approval -.->|throw| normalized',
    '  denied --> project',
    '  pre -.->|throw| normalized',
    '  toolBody --> fsGate',
    '  fsGate --> toolBody',
    '  toolBody --> owned',
    '  toolBody --> around',
    '  around --> project',
    '  project --> post',
    '  project -.->|throw| normalized',
    '  around -.->|wrapper throws| normalized',
    '  post -.->|throw| normalized',
    '  post --> finalize',
    '  normalized --> finalize',
    '  finalize --> final',
    '  final --> toolResult',
    '  toolResult --> presentResult',
    '  toolResult --> allResults',
    '  allResults --> context',
    '```',
    '',
    'Filesystem read-before-edit checks stay below `tool-fs` on `fs/*` events. Generic pre/post waterfalls host hooks and approval policy; `ctx.approval` resolves asks before monotonic guards, and owner policy that must not be reordered remains a registered guard. Around-dispatch concerns such as timeouts wrap `tools/execute`. The pipeline losslessly snapshots the candidate result and normalizes a snapshot failure before the visible definition\'s snapshotted `finalizeContent` callback enforces its synchronous content-only invariant. `tools/result` then observes the immutable, lossless-JSON outcome. This lets hooks span tool families without coupling the tools to one policy service. PTC mode sends both the reserved `run_code` transport and its ordered sub-calls through the pipeline; sub-calls carry the parent token, log `tool/ptc-dispatch`, return denials as binding rejections, and omit `additionalContexts` to preserve call/result adjacency.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderDocs(): GraphDoc[] {
  const pkgs = collectPackageGraph(root, GROUP_ORDER, 'gen-doc-graphs')
  const { model } = projectCordisCatalog(root, CORDIS_CATALOG_POLICY)
  const docs: GraphDoc[] = [
    { rel: 'docs/capability-seams.md', content: renderCapabilitySeams(pkgs, model.services) },
    ...APP_EXAMPLES.map(example => ({ rel: example.rel, content: renderAppComposition(example) })),
    { rel: 'docs/event-producer-consumer.md', content: renderEventRelations(pkgs, model.events) },
    { rel: 'docs/agent-lifecycle.md', content: renderLifecycle() },
    { rel: 'docs/tool-execution-pipeline.md', content: renderToolPipeline() },
  ]
  docs.unshift({ rel: 'docs/graph-atlas.md', content: renderIndex(docs) })
  const events = docs.find(doc => doc.rel === 'docs/event-producer-consumer.md')
  if (events !== undefined) docs.push(spliceChineseRegions(events))
  return docs
}

/**
 * Splice a generated page's regions into its authored Chinese counterpart,
 * localizing paired-document links; the surrounding Chinese prose stays authored.
 */
function spliceChineseRegions(doc: GraphDoc): GraphDoc {
  const rel = doc.rel.replace(/\.md$/, '.zh.md')
  const context = {
    repoRoot: root,
    sourcePath: rel,
    isTranslationPairSource: translationPairSourcePredicate(parseTranslationPairingManifest(
      readFileSync(resolve(root, 'scripts/translation-pairing.manifest.json'), 'utf8'),
    )),
  }
  let content = readFileSync(resolve(root, rel), 'utf8')
  for (const region of generatedRegions(doc.content)) {
    content = spliceGeneratedRegion(content, rewriteTranslationLinkLocales(region.text, context).content)
  }
  return { rel, content }
}

function renderIndex(docs: GraphDoc[]): string {
  const labels: Record<string, string> = {
    'docs/capability-seams.md': 'capability seams and core services',
    'apps/cli/composition.md': 'dsh shared base composition',
    'docs/event-producer-consumer.md': 'event producer/consumer matrix',
    'docs/agent-lifecycle.md': 'agent turn and step lifecycle',
    'docs/tool-execution-pipeline.md': 'tool execution pipeline',
  }
  const modes: Record<string, string> = {
    'docs/capability-seams.md': 'hybrid generated',
    'apps/cli/composition.md': 'hybrid generated',
    'docs/event-producer-consumer.md': 'hybrid generated',
    'docs/agent-lifecycle.md': 'curated',
    'docs/tool-execution-pipeline.md': 'curated',
  }
  const rows = [
    '| [module dependency graph](module-graph.md) | `generated` |',
    '| [tool schema catalog and package map](tool-catalog.md) | `generated` |',
    ...docs.map((doc) => {
      const link = graphIndexLink(doc.rel)
      return `| [${labels[doc.rel] ?? link}](${link}) | \`${modes[doc.rel] ?? 'generated'}\` |`
    }),
  ]
  const maintenance = 'mixed: each linked page declares generated, hybrid, or curated mode'
  return [
    ...generatedHeader('Documentation Graph Index'),
    'These diagrams show relationships that the generated catalogs do not. Use them to find package relationships, capability seams, event flow, model-facing tools, app composition, and runtime lifecycle paths. Exact signatures and type definitions still live in the [subsystem pages](subsystems/core.md) (types + the generated Cordis API regions) and [tool-catalog.md](tool-catalog.md).',
    '',
    'The process decision behind this index is recorded in [the documentation graph Agent Note](../.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.md).',
    '',
    '| Graph | Mode |',
    '| --- | --- |',
    ...rows,
    '',
    'Regenerate with `pnpm run gen-doc-graphs`; verify freshness with `pnpm run verify-doc-graphs`.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function memoize<A extends readonly unknown[], R>(
  compute: (...args: A) => R,
  key: (...args: A) => string,
  copy: (value: R) => R,
): (...args: A) => R {
  const results = new Map<string, R>()
  return (...args) => {
    const id = key(...args)
    const recorded = results.get(id)
    if (recorded !== undefined) return copy(recorded)
    const value = compute(...args)
    results.set(id, value)
    return copy(value)
  }
}

/**
 * Run read-only analysis with memoized TypeScript filesystem probes.
 *
 * While `run` executes, `fileExists`, `directoryExists`, `realpath`, `readDirectory`,
 * and `getDirectories` on `system` return the first result recorded for each distinct
 * argument list, so every compiler host and config parse built on it, including the
 * Typert programs and the event-relation Program, shares one view of the filesystem.
 * The workspace must not change while `run` executes. A probe that throws records
 * nothing, and array results are copied for each caller. The original methods are
 * restored when `run` returns or throws. The memo patches `system` itself, so `run`
 * must be synchronous and must not call this function again.
 * @param run - read-only analysis that runs under the memo.
 * @param system - TypeScript system whose probes are memoized.
 * @returns the value returned by `run`.
 */
export function withMemoizedFileSystemProbes<T>(run: () => T, system: ts.System = ts.sys): T {
  const probes = ['fileExists', 'directoryExists', 'realpath', 'readDirectory', 'getDirectories'] as const
  const descriptors = probes.map(name => [name, Object.getOwnPropertyDescriptor(system, name)] as const)
  const original: ts.System = { ...system }
  const same = <V>(value: V): V => value
  const copied = (value: string[]): string[] => [...value]
  system.fileExists = memoize((path: string) => original.fileExists(path), path => path, same)
  system.directoryExists = memoize((path: string) => original.directoryExists(path), path => path, same)
  if (original.realpath !== undefined) system.realpath = memoize(original.realpath.bind(original), path => path, same)
  system.readDirectory = memoize(
    (path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number) =>
      original.readDirectory(path, extensions, exclude, include, depth),
    (path, extensions, exclude, include, depth) => JSON.stringify([path, extensions, exclude, include, depth]),
    copied,
  )
  system.getDirectories = memoize((path: string) => original.getDirectories(path), path => path, copied)
  try {
    return run()
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(system, name)
      else Object.defineProperty(system, name, descriptor)
    }
  }
}

function main(): void {
  // renderDocs reads the workspace only; generated pages are written after the memo is removed.
  const docs = withMemoizedFileSystemProbes(renderDocs)
  if (process.argv.includes('--check')) {
    const stale: string[] = []
    for (const doc of docs) {
      const abs = resolve(root, doc.rel)
      const committed = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      if (committed !== doc.content) stale.push(doc.rel)
    }
    if (stale.length === 0) {
      console.log(`gen-doc-graphs: ${docs.length} graph doc(s) are up to date.`)
      return
    }
    console.error(`gen-doc-graphs: stale graph doc(s): ${stale.join(', ')}. Run \`pnpm run gen-doc-graphs\` and commit the result.`)
    process.exit(1)
  }

  for (const doc of docs) {
    mkdirSync(dirname(resolve(root, doc.rel)), { recursive: true })
    writeFileSync(resolve(root, doc.rel), doc.content)
  }
  console.log(`gen-doc-graphs: wrote ${docs.length} graph doc(s).`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
