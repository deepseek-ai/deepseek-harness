/**
 * Value exports that plugin entries already had when verify-plugin-entry-exports started enforcing the plugin entry
 * rule in docs/defensive-patterns/package-surface.md. Each line records existing debt, not an approved exception. The
 * gate passes a listed export and fails a line when its package has no plugin entry, when its export list is empty or
 * repeats a name, or when it names an export the entry no longer reports, so removing an export removes its line in
 * the same change. A line added after the gate's introduction is an exception under the rule, and the rule requires
 * the domain owner's confirmation for it.
 */
export const EXISTING_PLUGIN_ENTRY_EXPORTS = {
  '@deepseek-ai/dsh-acp-app': ['ACP_APP_STARTUP_SERVICE'],
  '@deepseek-ai/dsh-action-cards': ['Config', 'isPluginStopping'],
  '@deepseek-ai/dsh-agent': [
    'AgentModel', 'agentCarrier', 'agentEvents', 'assembleContextFor', 'emitAgentEvent', 'foldConsumedWork',
    'installModelSelection', 'modelSelectionProjectionDefinition',
  ],
  '@deepseek-ai/dsh-agent-instructions': [
    'discoverBaselineInstructionFiles', 'loadBaselineInstructions', 'renderAgentInstructions',
  ],
  '@deepseek-ai/dsh-agent-loop': ['CONFIGURED_AGENT_IDENTITIES_KEY', 'DEFAULT_MAX_PARALLEL_TOOL_CALLS'],
  '@deepseek-ai/dsh-agent-preset-registry': [
    'agentPresetProjectionDefinition', 'auditRows', 'entryListProblem', 'leakedServices',
  ],
  '@deepseek-ai/dsh-agent-team': ['TeamId', 'TeamMessageId', 'TeamTaskId'],
  '@deepseek-ai/dsh-api-remote-access': ['REMOTE_ACCESS_SNAPSHOT_KEY'],
  '@deepseek-ai/dsh-api-remotes': ['API_REMOTE_FORWARDED_EVENTS'],
  '@deepseek-ai/dsh-attachment-local': [
    'DEFAULT_IMAGE_COMPRESSION_CONCURRENCY', 'DEFAULT_MAX_IMAGES_PER_MESSAGE', 'DEFAULT_MAX_IMAGE_BYTES',
    'DEFAULT_MAX_IMAGE_DIMENSION', 'DEFAULT_MAX_IMAGE_PIXELS', 'DEFAULT_MAX_MESSAGE_IMAGE_BYTES',
    'DEFAULT_NORMALIZED_IMAGE_MAX_BYTES', 'DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION',
    'DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS', 'MAX_IMAGE_COMPRESSION_CONCURRENCY', 'canPassThroughNormalization',
    'commitPreparedImageFile', 'normalizeImage', 'prepareImageFile', 'readImageFile', 'readRequestImageFile',
    'requestImageVariantId', 'saveImageFile', 'validateImageFile',
  ],
  '@deepseek-ai/dsh-bash-local': ['ENV_OVERRIDES', 'assertServiceableBashConfig'],
  '@deepseek-ai/dsh-client-connection': [
    'API_PATH', 'CONNECT_PATH', 'Peer', 'RpcId', 'clientRequestSchema', 'rpcErrorSchema', 'rpcIdSchema',
    'rpcMessageSchema', 'rpcResultSchema', 'serverResponseSchema', 'transportError',
  ],
  '@deepseek-ai/dsh-client-hmr': ['EVENTS_ENDPOINT'],
  '@deepseek-ai/dsh-client-locale': ['LOCALE_IDS', 'LOCALE_PREFERENCE_FIELD', 'LOCALE_SETTINGS_NAMESPACE'],
  '@deepseek-ai/dsh-client-modules': ['bootInjections', 'orderByModuleGraph', 'stripClientSuffix'],
  '@deepseek-ai/dsh-client-ui-chat': [
    'CHAT_SETTINGS_NAMESPACE', 'DEFAULT_TRANSCRIPT_VIEW_MODE', 'LEGACY_EXPANDED_TRANSCRIPT_VIEW_MODE',
    'LEGACY_TRANSCRIPT_VIEW_MODE', 'TRANSCRIPT_VIEW_FIELD', 'TRANSCRIPT_VIEW_MODES',
  ],
  '@deepseek-ai/dsh-client-ui-conversation': [
    'BUSY_ENTER_BEHAVIORS', 'BUSY_ENTER_FIELD', 'CONVERSATION_SETTINGS_NAMESPACE', 'DEFAULT_BUSY_ENTER_BEHAVIOR',
  ],
  '@deepseek-ai/dsh-client-ui-theme': [
    'DEFAULT_FONT_SIZE', 'DEFAULT_PREFERENCE', 'FONT_SIZE_FIELD', 'FONT_SIZE_MAX', 'FONT_SIZE_MIN', 'THEME_PREFERENCES',
    'THEME_PREFERENCE_FIELD', 'THEME_SETTINGS_NAMESPACE',
  ],
  '@deepseek-ai/dsh-command-feedback': ['FEEDBACK_CATEGORIES', 'recordFeedback'],
  '@deepseek-ai/dsh-commands': ['CommandDefinitionId', 'CommandId', 'name', 'parseCommand'],
  '@deepseek-ai/dsh-compaction-tool-result-pruner': ['DEFAULTS', 'PRUNE_MARKER', 'codePointLength', 'resolveConfig'],
  '@deepseek-ai/dsh-cordis-host-runner': [
    'ApprovalRequestId', 'CordisDynamicPackageId', 'CordisDynamicPluginId', 'CordisDynamicPluginRunId',
  ],
  '@deepseek-ai/dsh-credentials-local': [
    'CREDENTIALS_FILENAME', 'DOCUMENT_VERSION', 'parseCredentialsDocument', 'renderFlatLayoutMigration', 'resolveSpec',
  ],
  '@deepseek-ai/dsh-cua': ['CuaConfig', 'installCua'],
  '@deepseek-ai/dsh-experimental-claude-code-mods': [
    'DEFAULT_TOOL_ALIASES', 'KNOWN_EVENTS', 'MODS_API_VERSION', 'SERVED_EVENTS', 'defineMod',
  ],
  '@deepseek-ai/dsh-experimental-cua-macos': ['GUIDANCE'],
  '@deepseek-ai/dsh-experimental-forge': ['changeRequestKey'],
  '@deepseek-ai/dsh-experimental-inspector': ['resolveInspectorOptions', 'startInspector'],
  '@deepseek-ai/dsh-experimental-ptc-runtime-python': [
    'checkDoneValue', 'detachResidual', 'encodeJsonPlain', 'hasNonLosslessNumber', 'hasUnsafeIntegerToken',
    'hostFrameParseCeiling', 'logTruncationMarker', 'readProcessStart', 'resolvePythonBin', 'validateChildFrame',
  ],
  '@deepseek-ai/dsh-experimental-worktree': [
    'CREATED_RECORD', 'createdWorktreeSchema', 'generatedWorktreeName', 'worktreeProjection',
  ],
  '@deepseek-ai/dsh-file-reference-local': [
    'DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES', 'DEFAULT_FILE_SEARCH_MAX_ENTRIES', 'DEFAULT_FILE_SEARCH_MAX_RESULTS',
    'FILE_REFERENCE_PROMPT', 'WorkspaceFileSearch', 'activeAtToken', 'formatFileMention',
  ],
  '@deepseek-ai/dsh-goal': [
    'GOAL_CHANGE_VERSION', 'GoalId', 'applyGoalProjection', 'decodeGoalChange', 'foldGoal', 'goalChangeRef',
    'goalProjectionDefinition',
  ],
  '@deepseek-ai/dsh-goal-round-driver': ['renderGoalRoundPrompt'],
  '@deepseek-ai/dsh-host-directory-picker-auto': [
    'BACKEND_PACKAGES', 'SURFACE_PACKAGES', 'canExecute', 'hasLinuxChooserBinary', 'resolveDirectoryPickerBackend',
  ],
  '@deepseek-ai/dsh-host-directory-picker-browse': ['boundedInsert', 'fullyQualified', 'raceAbort'],
  '@deepseek-ai/dsh-host-directory-picker-native': ['pickNativeDirectory'],
  '@deepseek-ai/dsh-host-plugin-inventory': ['pluginEntryId', 'readPluginInventory'],
  '@deepseek-ai/dsh-host-product-telemetry-otel': ['Config'],
  '@deepseek-ai/dsh-host-webserver': [
    'bindUrlHost', 'isLoopbackHost', 'isWildcardHost', 'normalizeBindAddress', 'renderIndexInjections',
  ],
  '@deepseek-ai/dsh-jobs-local': ['TASK_WAIT_TIMEOUT'],
  '@deepseek-ai/dsh-llm': [
    'ACCOUNT_QUOTA_EXCEEDED_CODE', 'APP_IDENTITY', 'AssistantStreamAccumulator', 'BlockAssembler',
    'CONTEXT_SUMMARY_MAX_CHARS', 'CONTEXT_WINDOW_EXCEEDED_CODE', 'EMPTY_RESPONSE_CODE', 'IMAGE_OFFLOAD_REQUIRED_CODE',
    'INVALID_CREDENTIAL_CODE', 'LLM_FAILURE_CODES', 'LlmAdapter', 'LlmAttemptId', 'MessageId', 'ProviderRequestId',
    'QUOTA_EXCEEDED_CODE', 'RETRY_CODE_CHOICES', 'ReasoningEffortId', 'RetryPolicySchema', 'ToolCallId',
    'assembleAssistantStream', 'assertUsableApiKey', 'assistantStreamChunks', 'assistantStreamFirstTokenTime',
    'assistantStreamHasVisibleContent', 'assistantStreamHasVisibleText', 'attributionHeaders', 'boundContextSummary',
    'callConfigEquals', 'chunkHasVisibleText', 'contentHasFile', 'contentHasImage', 'createAssistantMessage',
    'createDeveloperMessage', 'createMessage', 'createSystemMessage', 'createToolResultMessage', 'createUserMessage',
    'errorChain', 'expandAssistantStream', 'fileHandleText', 'freezeMessage', 'isAgentLoopRequest',
    'isContextWindowExceededError', 'isHarnessError', 'isQuotaExceededError', 'isTokenDelta', 'isVisibleChunk',
    'joinAssistantStreamText', 'lastAssistantStreamChunk', 'markAgentLoopRequest', 'normalizeApiKey',
    'offloadedImageText', 'projectFilesToText', 'projectImagesForTextModel', 'projectOffloadedImages',
    'projectToolUpdates', 'requestImageHandleText', 'requiredImageOffload', 'resolveImageAttachmentAccess',
    'resolveRetryPolicy', 'runFirstTokenTime', 'runFirstVisibleTime', 'textOnlyImageText', 'userAgent',
  ],
  '@deepseek-ai/dsh-llm-deepseek-account': ['plainAccountOptions', 'resolveAccountOptions'],
  '@deepseek-ai/dsh-llm-deepseek-api-key': ['plainOptions', 'resolveAdapterOptions'],
  '@deepseek-ai/dsh-llm-pi-ai': ['PiAiAdapter', 'recordKeyFor', 'supportedProtocols'],
  '@deepseek-ai/dsh-llm-replay': [
    'deriveReplayScript', 'installLlmReplay', 'loadReplayScript', 'loadSessionScripts', 'parseSessionHeader',
    'parseSessionLog', 'prepareSessionSnapshotFixtureForComparison', 'resolveScriptedEntry',
  ],
  '@deepseek-ai/dsh-llm-retry': ['RetryId'],
  '@deepseek-ai/dsh-lsp': ['LspProviderId', 'finalExtension'],
  '@deepseek-ai/dsh-lsp-stdio': [
    'LspConnection', 'LspInstance', 'MessageDecoder', 'canonicalizeWorkspace', 'encodeMessage',
    'negotiatePositionEncoding', 'normalizeHover', 'normalizeLocations', 'readHostSource', 'requestMethod',
    'supportsOperation', 'supportsTransientOpen',
  ],
  '@deepseek-ai/dsh-mcp-client': [
    'ReconnectSchema', 'SERVER_NAME_PATTERN', 'assertTemplateSyntax', 'connectionStatusOf', 'createMcpToolDefinition',
    'probeServer', 'resolveReconnectPolicy',
  ],
  '@deepseek-ai/dsh-office-kit': ['Config', 'OfficeKitGeneration', 'OfficeKitKey', 'OfficeSourceKey'],
  '@deepseek-ai/dsh-permission-presets': ['AUTO_PRESET', 'CUSTOM_PRESET'],
  '@deepseek-ai/dsh-persona': ['PERSONA_PREFIX_SECTION', 'PERSONA_SUFFIX_SECTION'],
  '@deepseek-ai/dsh-plan-mode': ['EXIT_PLAN_MODE', 'planProjectionDefinition', 'resolveConfig'],
  '@deepseek-ai/dsh-plugin-manager': ['classifyInstallFailure', 'parseInstallSpec', 'pinnedGitOrigin'],
  '@deepseek-ai/dsh-pwsh-local': [
    'ENCODING_PREAMBLE', 'ENV_OVERRIDES', 'assertServiceablePwshConfig', 'candidatePwshPaths', 'resolvePwshPath',
  ],
  '@deepseek-ai/dsh-sandbox-policy': ['SANDBOX_MODES', 'setSandboxMode'],
  '@deepseek-ai/dsh-schedule': [
    'DEFAULT_LIST_LIMIT', 'MAX_LIST_LIMIT', 'MAX_TITLE_LENGTH', 'MIN_EVERY_INTERVAL_SECONDS', 'REQUIRED_TITLE_MESSAGE',
    'ScheduleId', 'canonicalizeCronExpression', 'createAfterScheduleRecord', 'createAtScheduleRecord',
    'createCronScheduleRecord', 'createDailyScheduleRecord', 'createEveryScheduleRecord', 'createWeeklyScheduleRecord',
    'decodeScheduleRecord', 'formatScheduleLocalTime', 'isRecurringScheduleRecord', 'normalizeWeekdays',
    'parseCronInput', 'parseWeeklyInput', 'renderRecurringReminderBatchFraming', 'renderReminderFraming',
    'resolveCronOccurrence', 'resolveDailyOccurrence', 'resolveEveryOccurrence', 'resolveRecurringOccurrence',
    'resolveWeeklyOccurrence', 'scheduleDomain', 'scheduleTitle', 'weeklyTime',
  ],
  '@deepseek-ai/dsh-sdk-app': ['SDK_APP_STARTUP_SERVICE'],
  '@deepseek-ai/dsh-sdk-jsonrpc-server': ['HarnessSdkJsonRpcServer'],
  '@deepseek-ai/dsh-session': [
    'KNOWN_SESSION_EVENT_TYPES', 'SESSION_FORMAT_VERSION', 'Session', 'SessionId', 'SessionLogOffset',
    'SessionPreparation', 'SessionSeq', 'TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN', 'ToolCallRecovery',
    'adoptSessionEvent', 'appendPluginRecord', 'buildForkSeed', 'canonicalHeader', 'decodeSeqRanges',
    'deriveEventMessage', 'encodeSeqRanges', 'foldRequestHeader', 'foldSurface', 'headerEquals',
    'interruptedTurnClosers', 'isAppendSurfaceEvent', 'isReplacementSurfaceEvent', 'isSurfaceEligibleType',
    'isSurfaceEvent', 'pluginRecordOf', 'snapshotSessionEvent',
  ],
  '@deepseek-ai/dsh-session-log-deepseek': ['acceptedThrough'],
  '@deepseek-ai/dsh-session-log-export': [
    'DEFAULT_SESSION_LOG_COMPRESSION_LEVEL', 'SESSION_LOG_EXPORT_PATH', 'SESSION_LOG_FILENAME', 'flushLiveSessionLog',
    'formatSessionMarkdown', 'readSessionLogText', 'serializeSessionLog', 'sessionLogExportDeps',
    'sessionLogZipEntries', 'sessionLogZipFilename', 'streamSessionLogZip',
  ],
  '@deepseek-ai/dsh-session-persistence-jsonl': ['JsonlCompressionSchema'],
  '@deepseek-ai/dsh-session-projection-cache': [
    'Config', 'checkpointIdentity', 'checkpointRecord', 'checkpointRow', 'projectionCacheDomainSpec',
  ],
  '@deepseek-ai/dsh-session-query-sqlite': [
    'SESSION_QUERY_SQLITE_APPLICATION_ID', 'SESSION_QUERY_SQLITE_DEFAULT_LIMIT', 'SESSION_QUERY_SQLITE_MAX_LIMIT',
    'SESSION_QUERY_SQLITE_PATH_KEY', 'SESSION_QUERY_SQLITE_SCHEMA_VERSION', 'SESSION_QUERY_SQLITE_SNIPPET_CHARS',
  ],
  '@deepseek-ai/dsh-session-reference': [
    'DEFAULT_CANDIDATE_LIMIT', 'DEFAULT_MAX_REFERENCE_BYTES', 'MAX_REFERENCES', 'SESSION_REFERENCE_SCHEME',
    'decodeSessionReferenceUri', 'encodeSessionReferenceUri', 'formatSessionReferenceMention',
    'parseSessionReferenceText',
  ],
  '@deepseek-ai/dsh-session-telemetry-otel': [
    'Config', 'DEFAULT_SHUTDOWN_TIMEOUT_MILLIS', 'DEFAULT_TELEMETRY_MODE', 'SessionTelemetryMode',
  ],
  '@deepseek-ai/dsh-session-title': [
    'SessionTitleProviderId', 'fallbackSessionTitle', 'foldSessionTitle', 'normalizeSessionTitle',
    'titleProjectionDefinition', 'truncateTitleUtf8',
  ],
  '@deepseek-ai/dsh-settings': ['redactSecrets'],
  '@deepseek-ai/dsh-skill': [
    'BUNDLED_SKILL_RANK', 'escapeText', 'isModelInvocable', 'isSkillName', 'isUserInvocable', 'renderSkillContent',
  ],
  '@deepseek-ai/dsh-skill-filesystem': ['FileSystemSkillProvider'],
  '@deepseek-ai/dsh-spill-local': [
    'DEFAULT_ROOT_PREFIX', 'discoverDefaultRoots', 'encodeSegment', 'isErrno', 'privateRoot', 'saveTextFile',
    'sessionDir', 'sweepSpillRoots',
  ],
  '@deepseek-ai/dsh-storage': ['BackendRegistry', 'UNIT_NAME_RE', 'storageBackendServiceKey'],
  '@deepseek-ai/dsh-storage-domain': ['DomainFacility', 'defineDomain', 'descriptorOf', 'domainTable'],
  '@deepseek-ai/dsh-storage-json': ['JsonStorageBackend'],
  '@deepseek-ai/dsh-storage-sqlite': ['STORAGE_SQLITE_SCHEMA_VERSION', 'SqliteStorageBackend'],
  '@deepseek-ai/dsh-subagent': [
    'AssistantOutputFold', 'NO_START_CAPABILITIES', 'ROOT_AGENT_NAME', 'STRUCTURED_OUTPUT_TOOL',
    'SUBAGENT_DESCRIPTOR_VERSION', 'SubagentRunId', 'appendDelegatedPolicyOverrides', 'applyChildComposition',
    'assertPositiveFinite', 'assertSubagentMaxDepth', 'assertUsableCwd', 'captureDelegatedPolicyOverrides',
    'childSessionMeta', 'delegationDepthOf', 'finalAssistantOutput', 'foldSubagentDescriptor',
    'parentAgentOptionsForDelegation', 'resolveChildAgentOptions', 'resolveChildDepth', 'settleRunResult',
    'snapshotSubagentDescriptor', 'subprocessRunHandle',
  ],
  '@deepseek-ai/dsh-system-prompt': [
    'PERSONA_PREFIX_SECTION', 'PERSONA_SUFFIX_SECTION', 'TOOL_ORDER_REST', 'joinContextSections',
    'renderContextSections', 'renderContextSnapshot', 'renderPrompt',
  ],
  '@deepseek-ai/dsh-terminal': ['TerminalSessionId'],
  '@deepseek-ai/dsh-terminal-bash': ['BashTerminalBackend', 'PWSH_PROMPT_SETUP'],
  '@deepseek-ai/dsh-terminal-panel': ['GUIDANCE'],
  '@deepseek-ai/dsh-tool-call-timeout-policy': ['TOOL_TIMEOUT'],
  '@deepseek-ai/dsh-tool-executor-native': ['NativeToolExecutor'],
  '@deepseek-ai/dsh-tool-executor-ptc': [
    'PtcExecutor', 'jsonSchemaToPy', 'jsonSchemaToTs', 'renderToolsSdk', 'renderToolsSdkPy',
  ],
  '@deepseek-ai/dsh-tool-fs-search': [
    'GLOB_MAX_RESULTS', 'GLOB_VCS_EXCLUDES', 'GREP_MAX_LINE_BYTES', 'GREP_MAX_MATCHES', 'RAW_OUTPUT_MAX_BYTES',
    'SEARCH_GRACE_MS', 'SEARCH_META_MAX_BYTES', 'SEARCH_STDERR_MAX_BYTES', 'SEARCH_TIMEOUT_MS', 'applyGlobTool',
    'applyGrepTool', 'buildGlobCommand', 'buildGrepCommand', 'formatGlobOutput', 'formatGrepMatches',
    'formatGrepOutput', 'parseGlobArgs', 'parseGrepArgs', 'parseGrepMatches', 'presentGlobCall', 'presentGlobResult',
    'presentGrepCall', 'presentGrepResult', 'previewLine', 'resolveRgPath', 'runRipgrep', 'sampleAcrossTopLevel',
    'toWorkdirRelative', 'trySaveFormattedResult',
  ],
  '@deepseek-ai/dsh-tool-lsp': [
    'DEFAULT_LSP_TOOL_TIMEOUT_MS', 'DEFAULT_MAX_LOCATIONS', 'DEFAULT_MAX_RESULT_CHARS', 'LSP_OPERATIONS',
    'LSP_PROMPT_TEXT', 'formatHover', 'formatLocations', 'parseLspArgs', 'presentLspCall', 'renderUri',
  ],
  '@deepseek-ai/dsh-tool-session-query': ['DEFAULT_MAX_SEARCH_RESULTS', 'DEFAULT_SEARCH_TIMEOUT_MS'],
  '@deepseek-ai/dsh-tool-terminal': ['DEFAULT_MAX_RESULT_BYTES', 'MIN_MAX_RESULT_BYTES'],
  '@deepseek-ai/dsh-tool-web': [
    'DEFAULT_FETCH_MAX_OUTPUT_CHARS', 'DEFAULT_WEB_TOOL_TIMEOUT_MS', 'WEB_SEARCH_MAX_QUERIES', 'WEB_SEARCH_MAX_RESULTS',
    'applyWebFetchTool', 'applyWebSearchTool', 'fetchMetaFromResult', 'fetchMetaFromValue', 'formatFetchOutput',
    'formatSearchOutput', 'parseFetchArgs', 'presentFetchCall', 'presentFetchResult', 'presentSearchCall',
    'presentSearchResult', 'searchMetaFromResult', 'searchMetaFromValue',
  ],
  '@deepseek-ai/dsh-tool-workspace-dependencies': [
    'copyPrimaryRuntime', 'installPrimaryRuntime', 'parsePrimaryRuntime', 'primaryRuntimePythonAliases',
    'readPrimaryRuntime', 'resolvePrimaryRuntime', 'workspaceDependencyPaths',
  ],
  '@deepseek-ai/dsh-tools': [
    'RUN_CODE_NAME', 'TOOL_ABORTED', 'TOOL_ABORTED_BEFORE_DISPATCH', 'assertObjectJsonSchema',
    'assertSupportedJsonSchema', 'defineTool', 'isJsonSchemaRecord', 'isPlainJsonArray', 'isPlainJsonRecord',
    'parameterSchemaSpecToJsonSchema', 'projectToolSchema', 'validateArgs', 'validateJsonSchemaValue',
    'valueSchemaSpecToJsonSchema',
  ],
  '@deepseek-ai/dsh-typert-loader': ['TYPERT_HOST_EXPORT', 'validateTypertManifest'],
  '@deepseek-ai/dsh-typert-registry': ['typertEndpoint', 'typertKey', 'typertPackageKey'],
  '@deepseek-ai/dsh-user-approval': ['APPROVAL_POLICIES', 'ApprovalRequestId', 'setApprovalPolicy'],
  '@deepseek-ai/dsh-user-questions': ['TIMED_WAIT_PARAMETER', 'isTimedAskUserQuestionSchema'],
  '@deepseek-ai/dsh-web-app': ['internals'],
  '@deepseek-ai/dsh-web-deepseek-api': [
    'DEEPSEEK_DEFAULT_COUNT', 'DEEPSEEK_FETCH_API_PROVIDER_ID', 'DEEPSEEK_SEARCH_API_PROVIDER_ID',
    'DEEPSEEK_SEARCH_REQUESTS_PER_SECOND', 'DEEPSEEK_WEB_API_BASE_URL', 'DeepSeekFetchApiProvider',
    'DeepSeekSearchApiProvider', 'mapSearchResponse',
  ],
  '@deepseek-ai/dsh-web-fetch-http': ['DEFAULT_USER_AGENT', 'HttpFetchProvider', 'LOCAL_FETCH_PROVIDER_ID'],
  '@deepseek-ai/dsh-web-search-deepseek': [
    'DEEPSEEK_DEFAULT_API_VERSION', 'DEEPSEEK_DEFAULT_BASE_URL', 'DEEPSEEK_DEFAULT_MAX_TOKENS',
    'DEEPSEEK_DEFAULT_MAX_USES', 'DEEPSEEK_DEFAULT_MODEL', 'DEEPSEEK_PROVIDER_ID', 'DeepSeekSearchProvider',
    'WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE',
  ],
  '@deepseek-ai/dsh-webhook': ['WebhookDeliveryId', 'WebhookRuleId', 'WebhookSourceId'],
  '@deepseek-ai/dsh-workflow-ptc': ['materializeFromRealm', 'validateMeta'],
  '@deepseek-ai/dsh-workspace': [
    'WorkspaceId', 'realpathNormalize', 'workspaceDomainSpec', 'workspaceDomainState', 'workspaceRecord',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>
