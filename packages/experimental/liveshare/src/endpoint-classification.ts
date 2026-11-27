/**
 * Why each Remote endpoint may be called on a share viewer's behalf.
 *
 * LiveShare refuses by default: the `share-viewer` policy binds only the actions its roles list. This
 * table states, for every endpoint a Client build can name, which access condition puts that endpoint
 * on the list, so adding an endpoint cannot silently extend the reader’s reach. The Host derives
 * `POLICY_DECIDED_ACTIONS` from the `reader-*` entries, the Client compilation face proves the table
 * covers `RemoteEndpoint`, and the Host asserts at load that the derived set is exactly the actions its
 * roles list.
 *
 * Classes: `reader-*` entries are decided by the share-viewer policy and can never be exposed through
 * a plugin declaration; `always-allowed` bypasses every policy; `plugin-offered` is reachable only
 * through a plugin's live declaration and the owner's selection; `owner-only` is never exposed.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/endpoint-classification
 */

/** Why one Remote endpoint may be called on a share viewer's behalf. */
export type ViewerEndpointClass =
  | 'reader-global-read'
  | 'reader-session-read'
  | 'reader-workspace-read'
  | 'reader-session-input'
  | 'reader-fork'
  | 'reader-child-rename'
  | 'always-allowed'
  | 'plugin-offered'
  | 'owner-only'

/** The classes the share-viewer policy decides; the Host derives its decided-action set from them. */
export type ReaderEndpointClass = Extract<ViewerEndpointClass, `reader-${string}`>

/**
 * Every Remote endpoint this Client build can name, with the access condition that reaches it.
 *
 * The Client face checks this record against `Extract<keyof TypertRemoteMap, string>`; a new generated
 * endpoint without a class fails that compilation. The Host derives `POLICY_DECIDED_ACTIONS` from the
 * `reader-*` entries, so the policy whitelist has no second handwritten copy.
 */
export const VIEWER_ENDPOINT_CLASSES = {
  // ── reader-global-read ─────────────────────────────────────────────────────────────
  'llm/listConfigurableProviders': 'reader-global-read', // the page reads the configurable provider catalog
  'llm/listProviders': 'reader-global-read', // the page lists providers
  'session/canOpenWorkspacePath': 'reader-global-read', // the page asks whether a path can be opened
  'session/modelCatalog': 'reader-global-read', // the page reads the model catalog
  'pluginEvents/follow': 'reader-global-read', // the page follows the plugin graph; the Host sends a non-owner schema defaults, never configured values
  'productAnalytics/enabled': 'reader-global-read', // the page asks whether this host accepts analytics
  'productAnalytics/report': 'reader-global-read', // the page reports its own product events
  'productAnalytics/watchPolicy': 'reader-global-read', // the page follows the analytics policy
  'speech/cancelPreparation': 'reader-global-read', // the page cancels its recognizer preparation
  'speech/catalog': 'reader-global-read', // the page reads recorder providers and limits
  'speech/follow': 'reader-global-read', // the page follows recognizer readiness
  'speech/prepare': 'reader-global-read', // the page prepares a recognizer for its own recording
  'speech/transcribe': 'reader-global-read', // the page transcribes its own recording

  // ── reader-session-read ─────────────────────────────────────────────────────────────
  'commands/list': 'reader-session-read', // the page lists slash commands for a visible Session (also granted globally)
  'fileReferences/list': 'reader-session-read', // the reader lists files of a Session workspace it can read
  'fileUploads/upload': 'reader-session-read', // the reader attaches a file to a Session it can see; visibility alone decides
  'session/control': 'reader-session-read', // the page follows a visible Session control stream (also granted globally)
  'session/list': 'reader-session-read', // the page lists Sessions (also granted globally)
  'goals/get': 'reader-session-read', // the page reads the goal of a visible Session
  'goals/edit': 'reader-session-read', // the page edits the goal of a visible Session; visibility alone decides
  'goals/clear': 'reader-session-read', // the page clears the goal of a visible Session
  'goals/complete': 'reader-session-read', // the page completes the goal of a visible Session
  'goals/create': 'reader-session-read', // the page creates a goal on a visible Session
  'goals/pause': 'reader-session-read', // the page pauses the goal of a visible Session
  'goals/resume': 'reader-session-read', // the page resumes the goal of a visible Session
  'job/list': 'reader-session-read', // the page lists the background jobs of a visible Session
  'job/follow': 'reader-session-read', // the page follows one background job of a visible Session
  'sessionReferenceResolver/candidates': 'reader-session-read', // the page lists sessions for an @ reference
  'userQuestions/answer': 'reader-session-read', // the page answers a pending question of a visible Session
  'userQuestions/attachWait': 'reader-session-read', // the page joins a pending question of a visible Session
  'session/attachment': 'reader-session-read', // the page reads an attachment of a visible Session
  'session/follow': 'reader-session-read', // the page follows a visible Session
  'session/page': 'reader-session-read', // the page reads a visible Session page
  'session/projections': 'reader-session-read', // the page reads visible Session projections
  'skills/list': 'reader-session-read', // the page lists the skills of a visible Session
  'session/events': 'reader-session-read', // the page reads the event history of a visible Session
  'session/observeEvent': 'reader-session-read', // the page follows one visible Session's events
  'session/observeProjections': 'reader-session-read', // the page follows visible Session projections
  'session/observeState': 'reader-session-read', // the page follows a visible Session's passive state
  'session/state': 'reader-session-read', // the page reads a visible Session's passive state
  'session/wait': 'reader-session-read', // the page waits on a visible Session's passive state
  'toolResults/watch': 'reader-session-read', // the page inspects retained tool results of a visible Session

  // ── reader-workspace-read ─────────────────────────────────────────────────────────────
  'workspace/follow': 'reader-workspace-read', // the page follows a Workspace holding a visible Session (also granted globally)

  // ── reader-session-input ─────────────────────────────────────────────────────────────
  'session/prompt': 'reader-session-input', // the reader prompts the confined source (either tier) or its own child under its ceiling
  'session/cancel': 'reader-session-input', // the reader stops its own child; a concrete source cancel is performed by the share host

  // ── reader-fork ─────────────────────────────────────────────────────────────
  'session/fork': 'reader-fork', // the owner allowsFork switch decides the source and the reader’s own forks

  // ── reader-child-rename ─────────────────────────────────────────────────────────────
  'session/rename': 'reader-child-rename', // the reader renames only its own visible child, never the source

  // ── always-allowed ───────────────────────────────────────────────────────────
  'remoteAccess/follow': 'always-allowed', // every Peer reads its own access snapshot before any policy

  // ── owner-only ───────────────────────────────────────────────────────────────
  // No reader role names these, so the conservative class is owner-only. A share's method policy
  // decides whether one installed plugin's method reaches its viewers; this table only decides what
  // the core share roles grant.
  'account/cancelSignIn': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/getBalance': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/getProfile': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/getState': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/getNotificationContent': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/getNotifications': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/reportNotificationEvent': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/hasRunningAccountTasks': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/signOut': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/startSignIn': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/watch': 'owner-only', // owner account and sign-in; the served page never reads it
  'account/watchExpiry': 'owner-only', // owner account and sign-in; the served page never reads it
  'commands/execute': 'owner-only', // owner executes a slash command
  'job/kill': 'owner-only', // owner background jobs
  'session/create': 'owner-only', // owner creates a Session
  'session/initializeDefaultModel': 'owner-only', // owner initializes a Session default model
  'session/openWorkspacePath': 'owner-only', // owner opens a Workspace path
  'session/search': 'owner-only', // owner searches across Sessions
  'session/selectModel': 'owner-only', // owner selects a Session model
  'session/updateQueue': 'owner-only', // owner edits queued input
  'session/workspacePathApplications': 'owner-only', // owner applies a Workspace path
  'sessionStatus/follow': 'owner-only', // owner reading reminders
  'sessionStatus/mark': 'owner-only', // owner reading reminders
  'credentials/describe': 'owner-only', // owner credentials; secrets never reach a reader
  'credentials/set': 'owner-only', // owner credentials; secrets never reach a reader
  'credentials/unset': 'owner-only', // owner credentials; secrets never reach a reader
  'settings/describe': 'owner-only', // owner settings
  'settings/mutate': 'owner-only', // owner settings
  'settings/openSettingsDocument': 'owner-only', // owner settings
  'settings/replace': 'owner-only', // owner settings
  'settings/update': 'owner-only', // owner settings
  'terminal/attach': 'owner-only', // owner terminals
  'terminal/close': 'owner-only', // owner terminals
  'terminal/create': 'owner-only', // owner terminals
  'terminal/environment': 'owner-only', // owner terminals
  'terminal/list': 'owner-only', // owner terminals
  'terminal/rename': 'owner-only', // owner terminals
  'terminal/retain': 'owner-only', // owner terminals
  'terminal/shells': 'owner-only', // owner terminals
  'terminal/watch': 'owner-only', // owner terminals
  'directoryPicker/createDirectory': 'owner-only', // owner filesystem picker
  'directoryPicker/list': 'owner-only', // owner filesystem picker
  'directoryPicker/pick': 'owner-only', // owner filesystem picker
  'workspace/archiveSession': 'owner-only', // owner archives a Session
  'workspace/create': 'owner-only', // owner creates a Workspace
  'workspace/delete': 'owner-only', // owner deletes a Workspace
  'workspace/initializeDefault': 'owner-only', // owner initializes the default Workspace
  'workspace/insertBefore': 'owner-only', // owner reorders Workspaces
  'workspace/insertSessionBefore': 'owner-only', // owner reorders Sessions
  'workspace/pinSession': 'owner-only', // owner pins a Session
  'workspace/rename': 'owner-only', // owner renames a Workspace
  'workspace/unarchiveSession': 'owner-only', // owner unarchives a Session
  'workspace/unpinSession': 'owner-only', // owner unpins a Session
  'workspaceFiles/changes': 'owner-only', // owner Workspace file access
  'workspaceFiles/list': 'owner-only', // owner Workspace file access'
  'workspaceFiles/read': 'owner-only', // absolute paths reach files outside the Workspace, so no share offers it
  'workspaceFiles/readBytes': 'owner-only', // absolute paths reach files outside the Workspace, so no share offers it
  'workspaceFiles/search': 'owner-only', // owner Workspace file access
  'workspaceFiles/stat': 'owner-only', // absolute paths reach files outside the Workspace, so no share offers it
  'pluginManager/cancelInstall': 'owner-only', // owner plugin management
  'pluginManager/inspect': 'owner-only', // owner plugin management
  'pluginManager/installBundle': 'owner-only', // owner plugin management
  'pluginManager/listBundles': 'owner-only', // owner plugin management
  'pluginManager/listPlugins': 'owner-only', // owner plugin management
  'pluginManager/listVersionExemptions': 'owner-only', // owner plugin management
  'pluginManager/listVersions': 'owner-only', // owner plugin management
  'pluginManager/readBundleDetail': 'owner-only', // owner plugin management
  'pluginManager/registries': 'owner-only', // owner plugin management
  'pluginManager/removeBundle': 'owner-only', // owner plugin management
  'pluginManager/setBundleEnabled': 'owner-only', // owner plugin management
  'pluginManager/setPluginEnabled': 'owner-only', // owner plugin management
  'pluginManager/setVersionExemption': 'owner-only', // owner plugin management
  'pluginManager/updateBundle': 'owner-only', // owner plugin management
  'pluginManager/waitForInstall': 'owner-only', // owner plugin management
  'pluginMarket/listIndexes': 'owner-only', // owner plugin market
  'pluginMarket/readEntryDetail': 'owner-only', // owner plugin market
  'pluginMarket/search': 'owner-only', // owner plugin market
  'pluginMarket/setIndexes': 'owner-only', // owner plugin market
  'pluginRegistryProbe/fastest': 'owner-only', // owner plugin registry probe
  'actionCards/act': 'owner-only', // owner action on a card below an answer
  'pluginRecommendations/describe': 'owner-only', // owner plugin card text
  'connectorAccounts/cancel': 'owner-only', // owner connector accounts on the Plugins page
  'connectorAccounts/start': 'owner-only', // owner connector accounts on the Plugins page
  'connectorAccounts/watch': 'owner-only', // owner connector accounts on the Plugins page
  'connectors/removeServer': 'owner-only', // owner custom MCP servers in the Connectors tab
  'connectors/saveServer': 'owner-only', // owner custom MCP servers in the Connectors tab
  'connectors/setServerEnabled': 'owner-only', // owner custom MCP servers in the Connectors tab
  'connectors/watchServers': 'owner-only', // owner custom MCP servers in the Connectors tab
  'officeKit/generation': 'owner-only', // owner document export
  'officeKit/render': 'owner-only', // owner document export
  'speech/configure': 'owner-only', // owner voice input
  'readAloud/configure': 'owner-only', // owner preference
  'readAloud/follow': 'owner-only', // owner read-aloud; synthesis is billed to the owner
  'readAloud/plan': 'owner-only', // owner read-aloud
  'readAloud/sample': 'owner-only', // owner read-aloud; billed to the owner
  'readAloud/synthesize': 'owner-only', // owner read-aloud
  'claudeCodeMods/pressBand': 'owner-only', // owner Claude Code mods UI
  'claudeCodeMods/watchBand': 'owner-only', // owner Claude Code mods UI
  'cotTranslation/limits': 'owner-only', // owner chain-of-thought translation UI
  'cotTranslation/translate': 'owner-only', // owner chain-of-thought translation UI
  'cuaAccess/applicationIcons': 'owner-only', // owner computer-use permissions
  'cuaAccess/applications': 'owner-only', // owner computer-use permissions
  'cuaAccess/enablePersistentPtc': 'owner-only', // owner computer-use permissions
  'cuaAccess/openSettings': 'owner-only', // owner computer-use permissions
  'cuaAccess/ptcConfiguration': 'owner-only', // owner computer-use permissions
  'cuaAccess/requestPermission': 'owner-only', // owner computer-use permissions
  'cuaAccess/retryApproval': 'owner-only', // owner computer-use permissions
  'cuaAccess/revoke': 'owner-only', // owner computer-use permissions
  'cuaAccess/systemStatus': 'owner-only', // owner computer-use permissions
  'dynamicCordisRunner/getClientCode': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/inventory': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/invoke': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/reportClientGuardFailure': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/reportRenderFailure': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/resolveInspectQuery': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/resolveRequestRun': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/runHostHalf': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/settleUserRun': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/stopFromPanel': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/syncInspectManifest': 'owner-only', // owner dynamic plugin runner
  'dynamicCordisRunner/undefineFromPanel': 'owner-only', // owner dynamic plugin runner
  'sessionFeedback/record': 'owner-only', // owner command feedback
  'messageFeedback/delete': 'owner-only', // owner message feedback
  'messageFeedback/list': 'owner-only', // owner message feedback
  'messageFeedback/put': 'owner-only', // owner message feedback
  'pluginInventory/list': 'owner-only', // owner plugin inventory
  'mcpManager/probe': 'owner-only', // owner MCP server management
  'mcpManager/restart': 'owner-only', // owner MCP server management
  'mcpManager/watch': 'owner-only', // owner MCP server management
  'permissionPresets/catalog': 'owner-only', // owner permission presets
  'permissionPresets/set': 'owner-only', // owner switches the sandbox and approval preset; a viewer may not call it at any tier
  'llm/discoverModels': 'owner-only', // owner discovers models
  'web/listProviders': 'owner-only', // owner web search and fetch settings
  'agentPresets/list': 'owner-only', // owner agent presets
  'agentPresets/read': 'owner-only', // owner agent presets
  'agentPresets/select': 'owner-only', // owner agent presets
  'agentTeams/setEnabled': 'owner-only', // owner Team mode
  'schedule/catalog': 'owner-only', // owner schedules
  'schedule/create': 'owner-only', // owner schedules
  'schedule/deliveryLimits': 'owner-only', // owner schedules
  'schedule/deleteInactive': 'owner-only', // owner schedules
  'schedule/edit': 'owner-only', // owner schedules
  'schedule/history': 'owner-only', // owner schedules
  'schedule/list': 'owner-only', // owner schedules
  'schedule/run': 'owner-only', // owner schedules
  'schedule/view': 'owner-only', // owner schedules
  'subagents/interruptByUser': 'owner-only', // owner subagents
  'subagents/prompt': 'owner-only', // owner subagents
  'subagents/selectModelByUser': 'owner-only', // owner selects a subagent model

  // Owner share management stays on the owner's own page; a `share-viewer` Peer is refused first.
  'liveshareShares/audit': 'owner-only',
  'liveshareShares/capabilities': 'owner-only',
  'liveshareShares/create': 'owner-only',
  'liveshareShares/addSessions': 'owner-only',
  'liveshareShares/identity': 'owner-only',
  'liveshareShares/list': 'owner-only',
  'liveshareShares/reconnect': 'owner-only',
  'liveshareShares/relay': 'owner-only',
  'liveshareShares/setCapabilities': 'owner-only',
  'liveshareShares/setRelay': 'owner-only',
  'liveshareShares/stop': 'owner-only',
  'liveshareShares/testPublish': 'owner-only',
  'liveshareShares/testRelay': 'owner-only',
  'liveshareShares/updatePermissions': 'owner-only',
} as const satisfies Readonly<Record<string, ViewerEndpointClass>>

/**
 * Session notifications the share policy forwards to a served reader.
 *
 * Events are not Remote endpoints, so they are not keys of `VIEWER_ENDPOINT_CLASSES`; the policy roles
 * list them directly and the Host adds this set to `POLICY_DECIDED_ACTIONS` so a plugin declaration
 * cannot name one either.
 */
export const VIEWER_FORWARDED_EVENTS = [
  'event:api-session/activity',
  'event:api-session/added',
  'event:api-session/error',
  'event:api-session/removed',
  'event:api-session/status',
] as const

/** Whether a class is decided by the share-viewer policy. */
function isReaderClass(value: ViewerEndpointClass): value is ReaderEndpointClass {
  return value.startsWith('reader-')
}

/**
 * Endpoints the share-viewer policy decides, in table order.
 * @param classes - Classification table to read.
 * @returns The keys whose class starts with `reader-`.
 */
export function readerPolicyEndpoints<K extends string>(
  classes: Readonly<Record<K, ViewerEndpointClass>>,
): K[] {
  return (Object.keys(classes) as K[]).filter(key => isReaderClass(classes[key]))
}

/**
 * Assert two action sets name exactly the same keys, reporting both directions.
 *
 * The Host runs this when it derives `POLICY_DECIDED_ACTIONS`, so a classification table that drifts
 * from the policy roles fails at load instead of silently granting less or more.
 * @param actual - Keys the caller has.
 * @param expected - Keys the caller must have.
 * @param label - Set name for the failure message.
 * @throws {TypeError} When the sets differ; the message lists missing and unexpected keys.
 */
export function assertSameViewerActions(
  actual: Iterable<string>,
  expected: Iterable<string>,
  label: string,
): void {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = [...expectedSet].filter(action => !actualSet.has(action)).sort()
  const unexpected = [...actualSet].filter(action => !expectedSet.has(action)).sort()
  if (missing.length === 0 && unexpected.length === 0) return
  throw new TypeError(
    `liveshare: ${label} must name exactly the same actions; missing ${JSON.stringify(missing)}; `
    + `unexpected ${JSON.stringify(unexpected)}`,
  )
}
