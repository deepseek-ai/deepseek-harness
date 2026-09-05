<!-- 英文源文件由 scripts/gen-doc-graphs.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-doc-graphs` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/capability-seams.md` 重新记录配对。 -->

# 能力 Seams 与核心服务

[English](capability-seams.md) | 中文

服务可以是核心主干服务、可替换的能力 seam，也可以是组合包／组合点。下图展示了拥有服务声明的包、已知实现包，以及直接消费该服务的包。

```mermaid
flowchart LR
  pkg_attachment["attachment"]
  svc_attachments["ctx.attachments<br/>Durable binary attachment storage"]
  pkg_attachment_local["attachment-local"]
  pkg_api_session_controller["api-session-controller"]
  pkg_tool_fs["tool-fs"]
  pkg_llm_pi_ai["llm-pi-ai"]
  pkg_llm_deepseek["llm-deepseek"]
  pkg_client_file_upload["client-file-upload"]
  svc_fileUploads["ctx.fileUploads<br/>Agent-scoped staged file uploads"]
  pkg_llm["llm"]
  svc_llm["ctx.llm<br/>LLM adapter registry"]
  pkg_llm_replay["llm-replay"]
  pkg_agent_loop["agent-loop"]
  pkg_compaction_basic["compaction-basic"]
  pkg_deepseek_llm_api_extensions["deepseek-llm-api-extensions"]
  svc_deepseekLlmApiExtensions["ctx.deepseekLlmApiExtensions<br/>Official DeepSeek request extensions"]
  pkg_session_log_deepseek["session-log-deepseek"]
  pkg_plugin_package_inventory_deepseek["plugin-package-inventory-deepseek"]
  pkg_token_meter["token-meter"]
  svc_tokenMeter["ctx.tokenMeter<br/>Replay token measurement"]
  pkg_compaction_tool_result_pruner["compaction-tool-result-pruner"]
  svc_toolResultPruner["ctx.toolResultPruner<br/>Model-free tool-result pruning"]
  pkg_session["session"]
  svc_sessions["ctx.sessions<br/>In-memory session store"]
  pkg_agent["agent"]
  pkg_session_persistence["session-persistence"]
  pkg_session_query["session-query"]
  pkg_session_query_sqlite["session-query-sqlite"]
  pkg_subagent_in_process_driver["subagent-in-process-driver"]
  pkg_invariants["invariants"]
  pkg_message_feedback["message-feedback"]
  svc_sessionController["ctx.sessionController<br/>Host Session Remote controller"]
  svc_sessionFileReferences["ctx.sessionFileReferences<br/>Session-addressed file-reference Remote adapter"]
  svc_sessionSkillCatalog["ctx.sessionSkillCatalog<br/>Session-addressed skill Remote adapter"]
  pkg_api_settings_controller["api-settings-controller"]
  svc_credentialsController["ctx.credentialsController<br/>Host credential-surface Remote controller"]
  svc_settingsController["ctx.settingsController<br/>Host settings-surface Remote controller"]
  pkg_api_workspace_controller["api-workspace-controller"]
  svc_workspaceController["ctx.workspaceController<br/>Host Workspace Remote controller"]
  svc_directoryPickerController["ctx.directoryPickerController<br/>Host directory-picking Remote controller"]
  svc_invariants["ctx.invariants<br/>Package-owned invariant registry"]
  pkg_scope["scope"]
  pkg_typert_registry["typert-registry"]
  svc_typert["ctx.typert<br/>Runtime type registry"]
  pkg_typert_loader["typert-loader"]
  pkg_api_gateway["api-gateway"]
  svc_typertGateway["ctx.typertGateway<br/>Typert Host invocation gateway"]
  svc_sessionPersistence["ctx.sessionPersistence<br/>Durable session persistence seam"]
  pkg_session_persistence_jsonl["session-persistence-jsonl"]
  pkg_tool_bash["tool-bash"]
  pkg_hooks_claude_code["hooks-claude-code"]
  pkg_hooks_codex["hooks-codex"]
  pkg_settings["settings"]
  svc_settings["ctx.settings<br/>User-settings seam"]
  pkg_settings_file["settings-file"]
  pkg_tool_subagent["tool-subagent"]
  svc_subagentModelSelection["ctx.subagentModelSelection<br/>Subagent model-selection preference"]
  pkg_credentials["credentials"]
  svc_credentials["ctx.credentials<br/>Credential seam"]
  pkg_credentials_local["credentials-local"]
  pkg_authorization["authorization"]
  svc_authorization["ctx.authorization<br/>Authorization flow registry"]
  pkg_session_telemetry["session-telemetry"]
  svc_sessionTelemetry["ctx.sessionTelemetry<br/>Session telemetry seam"]
  pkg_session_telemetry_otel["session-telemetry-otel"]
  pkg_storage["storage"]
  svc_storage["ctx.storage<br/>Non-session storage hub"]
  pkg_storage_json["storage-json"]
  pkg_storage_sqlite["storage-sqlite"]
  pkg_storage_domain["storage-domain"]
  svc_storageDomain["ctx.storageDomain<br/>Domain data facility"]
  pkg_workspace["workspace"]
  svc_messageFeedback["ctx.messageFeedback<br/>Lifecycle-bound message feedback"]
  svc_workspaceRegistry["ctx.workspaceRegistry<br/>Workspace entity registry"]
  svc_sessionQuery["ctx.sessionQuery<br/>Session reads, traces, filters, and search"]
  pkg_session_reference["session-reference"]
  pkg_tool_session_query["tool-session-query"]
  pkg_file_reference["file-reference"]
  svc_fileReferences["ctx.fileReferences<br/>File reference discovery"]
  pkg_file_reference_local["file-reference-local"]
  svc_sessionReferenceResolver["ctx.sessionReferenceResolver<br/>Cross-session snapshot preparation"]
  pkg_session_title["session-title"]
  svc_sessionTitle["ctx.sessionTitle<br/>Log-backed session titles"]
  pkg_session_title_first_prompt_llm["session-title-first-prompt-llm"]
  pkg_session_title_all_prompts_llm["session-title-all-prompts-llm"]
  pkg_system_prompt["system-prompt"]
  svc_systemPrompt["ctx.systemPrompt<br/>System prompt assembly registry"]
  pkg_tools["tools"]
  pkg_tool_terminal["tool-terminal"]
  pkg_tool_web["tool-web"]
  svc_tools["ctx.tools<br/>Tool registry and guarded execution pipeline"]
  pkg_tool_ask_user["tool-ask-user"]
  pkg_tool_cordis["tool-cordis"]
  pkg_tool_skill["tool-skill"]
  pkg_tool_todo["tool-todo"]
  pkg_user_questions["user-questions"]
  svc_userQuestions["ctx.userQuestions<br/>Human question/answer seam"]
  pkg_plan_mode["plan-mode"]
  svc_planMode["ctx.planMode<br/>Plan collaboration state"]
  pkg_agent_presets["agent-presets"]
  svc_agentPresets["ctx.agentPresets<br/>Per-session agent composition"]
  pkg_commands["commands"]
  svc_commands["ctx.commands<br/>Human command registry"]
  pkg_session_projection["session-projection"]
  svc_sessionProjections["ctx.sessionProjections<br/>Session projection units"]
  pkg_session_projection_cache["session-projection-cache"]
  svc_sessionProjectionCache["ctx.sessionProjectionCache<br/>Persisted projection cache"]
  pkg_subagent["subagent"]
  pkg_skill["skill"]
  svc_skills["ctx.skills<br/>Skill provider registry"]
  pkg_skill_badge["skill-badge"]
  pkg_skill_filesystem["skill-filesystem"]
  svc_agents["ctx.agents<br/>Agent service"]
  pkg_acp["acp"]
  pkg_agent_default_model["agent-default-model"]
  svc_agentDefaultModel["ctx.agentDefaultModel<br/>Default Agent model selection"]
  pkg_headless["headless"]
  svc_agentLoop["ctx.agentLoop<br/>Concrete loop driver"]
  pkg_base["base"]
  pkg_sdk_minimal["sdk-minimal"]
  pkg_mcp_manager["mcp-manager"]
  svc_mcpServers["ctx.mcpServers<br/>Settings-driven MCP server fleet"]
  pkg_goal["goal"]
  svc_goals["ctx.goals<br/>Same-session goal domain"]
  pkg_e2b["e2b"]
  svc_e2b["ctx.e2b<br/>E2B sandbox lifecycle owner"]
  pkg_fs_e2b["fs-e2b"]
  pkg_subprocess_e2b["subprocess-e2b"]
  pkg_subprocess["subprocess"]
  svc_subprocess["ctx.subprocess<br/>Subprocess seam"]
  pkg_subprocess_local["subprocess-local"]
  pkg_bash_local["bash-local"]
  pkg_bash_sandbox["bash-sandbox"]
  pkg_terminal_bash["terminal-bash"]
  pkg_lsp_stdio["lsp-stdio"]
  pkg_subagent_acp["subagent-acp"]
  pkg_subagent_codex["subagent-codex"]
  pkg_subagent_claude_code["subagent-claude-code"]
  pkg_shell["shell"]
  svc_shell["ctx.shell<br/>Bash executor seam"]
  pkg_pwsh_local["pwsh-local"]
  pkg_tool_pwsh["tool-pwsh"]
  pkg_shell_env["shell-env"]
  svc_shellEnv["ctx.shellEnv<br/>Managed bash environment registry"]
  pkg_terminal["terminal"]
  svc_terminals["ctx.terminals<br/>Persistent PTY session registry"]
  pkg_sandbox["sandbox"]
  svc_sandbox["ctx.sandbox<br/>Process-sandbox seam"]
  pkg_sandbox_local["sandbox-local"]
  pkg_sandbox_policy["sandbox-policy"]
  svc_sandboxPolicy["ctx.sandboxPolicy<br/>Sandbox policy home"]
  pkg_fs_sandbox["fs-sandbox"]
  pkg_user_approval["user-approval"]
  svc_approval["ctx.approval<br/>Approval seam"]
  pkg_permission_presets["permission-presets"]
  svc_permissionPresets["ctx.permissionPresets<br/>Permission presets"]
  pkg_code_runtime["code-runtime"]
  svc_codeRuntime["ctx.codeRuntime<br/>Code-execution seam"]
  pkg_code_runtime_worker_thread["code-runtime-worker-thread"]
  pkg_experimental_code_runtime_python["experimental-code-runtime-python"]
  pkg_fs["fs"]
  svc_fs["ctx.fs<br/>Filesystem provider seam"]
  pkg_fs_local["fs-local"]
  pkg_fs_observation_policy["fs-observation-policy"]
  pkg_compaction["compaction"]
  svc_compaction["ctx.compaction<br/>Compaction seam"]
  svc_subagents["ctx.subagents<br/>Subagent provider and continuation service"]
  pkg_subagent_spawn_in_process["subagent-spawn-in-process"]
  pkg_subagent_fork_in_process["subagent-fork-in-process"]
  pkg_subagent_dsh_sdk["subagent-dsh-sdk"]
  pkg_tool_subagent_control["tool-subagent-control"]
  pkg_tool_ralph["tool-ralph"]
  pkg_experimental_agent_team["experimental-agent-team"]
  svc_agentTeams["ctx.agentTeams<br/>Agent Teams coordination domain"]
  pkg_experimental_tool_agent_team["experimental-tool-agent-team"]
  pkg_experimental_client_ui_agent_team["experimental-client-ui-agent-team"]
  pkg_inspector["inspector"]
  svc_inspector["ctx.inspector<br/>Cross-realm runtime inspection"]
  pkg_jobs["jobs"]
  svc_jobs["ctx.jobs<br/>Background job registry"]
  pkg_jobs_local["jobs-local"]
  pkg_tool_jobs["tool-jobs"]
  pkg_web["web"]
  svc_web["ctx.web<br/>Web access provider registry"]
  pkg_web_search_exa["web-search-exa"]
  pkg_web_search_perplexity["web-search-perplexity"]
  pkg_web_search_deepseek["web-search-deepseek"]
  pkg_web_fetch_http["web-fetch-http"]
  pkg_spill["spill"]
  svc_spillStore["ctx.spillStore<br/>Spill storage seam"]
  pkg_spill_local["spill-local"]
  pkg_spill_policy["spill-policy"]
  pkg_host_directory_picker["host-directory-picker"]
  svc_directoryPicker["ctx.directoryPicker<br/>Workspace-directory picking seam"]
  pkg_host_directory_picker_native["host-directory-picker-native"]
  pkg_host_directory_picker_browse["host-directory-picker-browse"]
  pkg_host_webserver["host-webserver"]
  svc_webServer["ctx.webServer<br/>HTTP route registration"]
  pkg_client_connection["client-connection"]
  pkg_client_modules["client-modules"]
  pkg_client_hmr["client-hmr"]
  svc_clientModules["ctx.clientModules<br/>Client plugin graph host"]
  pkg_workflow["workflow"]
  svc_workflowEngine["ctx.workflowEngine<br/>Workflow script engine"]
  pkg_workflow_worker_thread["workflow-worker-thread"]
  pkg_tool_workflow["tool-workflow"]
  pkg_webhook["webhook"]
  svc_webhookRuntime["ctx.webhookRuntime<br/>Webhook rule runtime"]
  pkg_webhook_github["webhook-github"]
  pkg_lsp["lsp"]
  svc_lsp["ctx.lsp<br/>Language-server navigation seam"]
  pkg_tool_lsp["tool-lsp"]
  pkg_cordis_host_runner["cordis-host-runner"]
  svc_dynamicCordisRunner["ctx.dynamicCordisRunner<br/>Dynamic Cordis package host runner"]
  svc_cordisInspect["ctx.cordisInspect<br/>Dynamic Cordis inspect registry"]
  pkg_agent --> svc_agents
  pkg_agent_default_model --> svc_agentDefaultModel
  pkg_agent_loop --> svc_agentLoop
  pkg_agent_presets --> svc_agentPresets
  pkg_api_gateway --> svc_typertGateway
  pkg_api_session_controller --> svc_sessionController
  pkg_api_session_controller --> svc_sessionFileReferences
  pkg_api_session_controller --> svc_sessionSkillCatalog
  pkg_api_settings_controller --> svc_credentialsController
  pkg_api_settings_controller --> svc_settingsController
  pkg_api_workspace_controller --> svc_directoryPickerController
  pkg_api_workspace_controller --> svc_workspaceController
  pkg_attachment --> svc_attachments
  pkg_attachment_local --> svc_attachments
  pkg_authorization --> svc_authorization
  pkg_bash_local --> svc_shell
  pkg_bash_sandbox --> svc_shell
  pkg_client_file_upload --> svc_fileUploads
  pkg_client_modules --> svc_clientModules
  pkg_code_runtime --> svc_codeRuntime
  pkg_code_runtime_worker_thread --> svc_codeRuntime
  pkg_commands --> svc_commands
  pkg_compaction --> svc_compaction
  pkg_compaction_basic --> svc_compaction
  pkg_compaction_tool_result_pruner --> svc_toolResultPruner
  pkg_cordis_host_runner --> svc_cordisInspect
  pkg_cordis_host_runner --> svc_dynamicCordisRunner
  pkg_credentials --> svc_credentials
  pkg_credentials_local --> svc_credentials
  pkg_deepseek_llm_api_extensions --> svc_deepseekLlmApiExtensions
  pkg_e2b --> svc_e2b
  pkg_experimental_agent_team --> svc_agentTeams
  pkg_experimental_code_runtime_python --> svc_codeRuntime
  pkg_file_reference --> svc_fileReferences
  pkg_file_reference_local --> svc_fileReferences
  pkg_fs --> svc_fs
  pkg_fs_e2b --> svc_fs
  pkg_fs_local --> svc_fs
  pkg_fs_sandbox --> svc_fs
  pkg_goal --> svc_goals
  pkg_host_directory_picker --> svc_directoryPicker
  pkg_host_directory_picker_browse --> svc_directoryPicker
  pkg_host_directory_picker_native --> svc_directoryPicker
  pkg_host_webserver --> svc_webServer
  pkg_inspector --> svc_inspector
  pkg_invariants --> svc_invariants
  pkg_jobs --> svc_jobs
  pkg_jobs_local --> svc_jobs
  pkg_llm --> svc_llm
  pkg_llm_deepseek --> svc_llm
  pkg_llm_pi_ai --> svc_llm
  pkg_llm_replay --> svc_llm
  pkg_lsp --> svc_lsp
  pkg_lsp_stdio --> svc_lsp
  pkg_mcp_manager --> svc_mcpServers
  pkg_message_feedback --> svc_messageFeedback
  pkg_permission_presets --> svc_permissionPresets
  pkg_plan_mode --> svc_planMode
  pkg_plugin_package_inventory_deepseek --> svc_deepseekLlmApiExtensions
  pkg_pwsh_local --> svc_shell
  pkg_sandbox --> svc_sandbox
  pkg_sandbox_local --> svc_sandbox
  pkg_sandbox_policy --> svc_sandboxPolicy
  pkg_session --> svc_sessions
  pkg_session_log_deepseek --> svc_deepseekLlmApiExtensions
  pkg_session_persistence --> svc_sessionPersistence
  pkg_session_persistence_jsonl --> svc_sessionPersistence
  pkg_session_projection --> svc_sessionProjections
  pkg_session_projection_cache --> svc_sessionProjectionCache
  pkg_session_query --> svc_sessionQuery
  pkg_session_query_sqlite --> svc_sessionQuery
  pkg_session_reference --> svc_sessionReferenceResolver
  pkg_session_telemetry --> svc_sessionTelemetry
  pkg_session_telemetry_otel --> svc_sessionTelemetry
  pkg_session_title --> svc_sessionTitle
  pkg_session_title_all_prompts_llm --> svc_sessionTitle
  pkg_session_title_first_prompt_llm --> svc_sessionTitle
  pkg_settings --> svc_settings
  pkg_settings_file --> svc_settings
  pkg_shell --> svc_shell
  pkg_shell_env --> svc_shellEnv
  pkg_skill --> svc_skills
  pkg_skill_badge --> svc_skills
  pkg_skill_filesystem --> svc_skills
  pkg_spill --> svc_spillStore
  pkg_spill_local --> svc_spillStore
  pkg_storage --> svc_storage
  pkg_storage_domain --> svc_storageDomain
  pkg_storage_json --> svc_storage
  pkg_storage_sqlite --> svc_storage
  pkg_subagent --> svc_subagents
  pkg_subagent_acp --> svc_subagents
  pkg_subagent_claude_code --> svc_subagents
  pkg_subagent_codex --> svc_subagents
  pkg_subagent_dsh_sdk --> svc_subagents
  pkg_subagent_fork_in_process --> svc_subagents
  pkg_subagent_spawn_in_process --> svc_subagents
  pkg_subprocess --> svc_subprocess
  pkg_subprocess_e2b --> svc_subprocess
  pkg_subprocess_local --> svc_subprocess
  pkg_system_prompt --> svc_systemPrompt
  pkg_terminal --> svc_terminals
  pkg_terminal_bash --> svc_terminals
  pkg_token_meter --> svc_tokenMeter
  pkg_tool_subagent --> svc_subagentModelSelection
  pkg_tools --> svc_tools
  pkg_typert_registry --> svc_typert
  pkg_user_approval --> svc_approval
  pkg_user_questions --> svc_userQuestions
  pkg_web --> svc_web
  pkg_web_fetch_http --> svc_web
  pkg_web_search_deepseek --> svc_web
  pkg_web_search_exa --> svc_web
  pkg_web_search_perplexity --> svc_web
  pkg_webhook --> svc_webhookRuntime
  pkg_workflow --> svc_workflowEngine
  pkg_workflow_worker_thread --> svc_workflowEngine
  pkg_workspace --> svc_workspaceRegistry
  svc_agentDefaultModel --> pkg_api_session_controller
  svc_agentDefaultModel --> pkg_headless
  svc_agentLoop --> pkg_base
  svc_agentLoop --> pkg_sdk_minimal
  svc_agentTeams --> pkg_experimental_client_ui_agent_team
  svc_agentTeams --> pkg_experimental_tool_agent_team
  svc_agents --> pkg_acp
  svc_agents --> pkg_agent_loop
  svc_agents --> pkg_subagent_in_process_driver
  svc_approval --> pkg_acp
  svc_approval --> pkg_tool_bash
  svc_approval --> pkg_tools
  svc_attachments --> pkg_api_session_controller
  svc_attachments --> pkg_llm_deepseek
  svc_attachments --> pkg_llm_pi_ai
  svc_attachments --> pkg_tool_fs
  svc_authorization --> pkg_llm_pi_ai
  svc_clientModules --> pkg_client_hmr
  svc_codeRuntime --> pkg_tools
  svc_compaction --> pkg_compaction_basic
  svc_cordisInspect --> pkg_tool_cordis
  svc_credentials --> pkg_api_settings_controller
  svc_credentials --> pkg_llm_deepseek
  svc_credentials --> pkg_llm_pi_ai
  svc_deepseekLlmApiExtensions --> pkg_llm_deepseek
  svc_directoryPicker --> pkg_api_workspace_controller
  svc_dynamicCordisRunner --> pkg_tool_cordis
  svc_e2b --> pkg_fs_e2b
  svc_e2b --> pkg_subprocess_e2b
  svc_fileReferences --> pkg_api_session_controller
  svc_fileUploads --> pkg_api_session_controller
  svc_fs --> pkg_tool_fs
  svc_invariants --> pkg_agent
  svc_invariants --> pkg_agent_loop
  svc_invariants --> pkg_scope
  svc_invariants --> pkg_session
  svc_jobs --> pkg_tool_bash
  svc_jobs --> pkg_tool_jobs
  svc_jobs --> pkg_tool_subagent
  svc_jobs --> pkg_tool_terminal
  svc_llm --> pkg_agent_loop
  svc_llm --> pkg_compaction_basic
  svc_lsp --> pkg_tool_lsp
  svc_sandbox --> pkg_bash_sandbox
  svc_sandbox --> pkg_terminal_bash
  svc_sandboxPolicy --> pkg_bash_sandbox
  svc_sandboxPolicy --> pkg_fs_sandbox
  svc_sandboxPolicy --> pkg_terminal_bash
  svc_sessionPersistence --> pkg_agent_loop
  svc_sessionPersistence --> pkg_hooks_claude_code
  svc_sessionPersistence --> pkg_hooks_codex
  svc_sessionPersistence --> pkg_message_feedback
  svc_sessionPersistence --> pkg_session_query
  svc_sessionPersistence --> pkg_session_query_sqlite
  svc_sessionPersistence --> pkg_tool_bash
  svc_sessionProjectionCache --> pkg_api_session_controller
  svc_sessionProjectionCache --> pkg_session_query
  svc_sessionProjectionCache --> pkg_session_reference
  svc_sessionProjectionCache --> pkg_subagent
  svc_sessionProjections --> pkg_api_session_controller
  svc_sessionProjections --> pkg_session_title
  svc_sessionProjections --> pkg_tool_todo
  svc_sessionQuery --> pkg_session_reference
  svc_sessionQuery --> pkg_tool_session_query
  svc_sessions --> pkg_agent
  svc_sessions --> pkg_agent_loop
  svc_sessions --> pkg_invariants
  svc_sessions --> pkg_message_feedback
  svc_sessions --> pkg_session_persistence
  svc_sessions --> pkg_session_query
  svc_sessions --> pkg_session_query_sqlite
  svc_sessions --> pkg_subagent_in_process_driver
  svc_settings --> pkg_api_settings_controller
  svc_settings --> pkg_llm_deepseek
  svc_settings --> pkg_llm_pi_ai
  svc_shell --> pkg_hooks_claude_code
  svc_shell --> pkg_hooks_codex
  svc_shell --> pkg_tool_bash
  svc_shell --> pkg_tool_pwsh
  svc_shellEnv --> pkg_tool_bash
  svc_shellEnv --> pkg_tool_pwsh
  svc_skills --> pkg_tool_skill
  svc_spillStore --> pkg_spill_policy
  svc_storage --> pkg_storage_domain
  svc_storageDomain --> pkg_message_feedback
  svc_storageDomain --> pkg_workspace
  svc_subagentModelSelection --> pkg_tool_subagent
  svc_subagents --> pkg_tool_ralph
  svc_subagents --> pkg_tool_subagent
  svc_subagents --> pkg_tool_subagent_control
  svc_subprocess --> pkg_bash_local
  svc_subprocess --> pkg_bash_sandbox
  svc_subprocess --> pkg_lsp_stdio
  svc_subprocess --> pkg_subagent_acp
  svc_subprocess --> pkg_subagent_claude_code
  svc_subprocess --> pkg_subagent_codex
  svc_subprocess --> pkg_terminal_bash
  svc_systemPrompt --> pkg_agent_loop
  svc_systemPrompt --> pkg_tool_fs
  svc_systemPrompt --> pkg_tool_terminal
  svc_systemPrompt --> pkg_tool_web
  svc_systemPrompt --> pkg_tools
  svc_terminals --> pkg_tool_terminal
  svc_tokenMeter --> pkg_compaction_basic
  svc_toolResultPruner --> pkg_compaction_basic
  svc_tools --> pkg_agent_loop
  svc_tools --> pkg_tool_ask_user
  svc_tools --> pkg_tool_bash
  svc_tools --> pkg_tool_cordis
  svc_tools --> pkg_tool_fs
  svc_tools --> pkg_tool_skill
  svc_tools --> pkg_tool_subagent
  svc_tools --> pkg_tool_terminal
  svc_tools --> pkg_tool_todo
  svc_tools --> pkg_tool_web
  svc_typert --> pkg_api_gateway
  svc_typert --> pkg_typert_loader
  svc_userQuestions --> pkg_tool_ask_user
  svc_web --> pkg_tool_web
  svc_webServer --> pkg_client_connection
  svc_webServer --> pkg_client_hmr
  svc_webServer --> pkg_client_modules
  svc_webhookRuntime --> pkg_webhook_github
  svc_workflowEngine --> pkg_tool_ralph
  svc_workflowEngine --> pkg_tool_workflow
  svc_workspaceRegistry --> pkg_api_session_controller
  svc_workspaceRegistry --> pkg_api_workspace_controller
  svc_fs -. event gate .-> pkg_fs_observation_policy
```

| ctx 键 | 角色 | 所属包 | 实现 | 直接消费方 | 配套插件 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `ctx.attachments` | `seam` | [`attachment`](../packages/attachment/attachment) | [`attachment-local`](../packages/attachment/attachment-local) | [`api-session-controller`](../packages/api/session-controller), [`tool-fs`](../packages/fs/tool-fs), [`llm-pi-ai`](../packages/llm/llm-pi-ai), [`llm-deepseek`](../packages/llm/llm-deepseek) | - | 宿主会在会话事件之前提交已接受的图片；提供方适配器将已授权的持久引用解析为提供方原生内容。 |
| `ctx.fileUploads` | `core` | [`client-file-upload`](../packages/client/file-upload) | - | [`api-session-controller`](../packages/api/session-controller) | - | 负责流式接收、持久存储和暂存回执生命周期；Session Controller 将回执绑定到已接受的提交。 |
| `ctx.llm` | `seam` | [`llm`](../packages/llm/llm) | [`llm-deepseek`](../packages/llm/llm-deepseek), [`llm-pi-ai`](../packages/llm/llm-pi-ai), [`llm-replay`](../packages/test-support/llm-replay) | [`agent-loop`](../packages/core/agent-loop), [`compaction-basic`](../packages/compaction/compaction-basic) | - | 适配器注册提供方实现；agent loop（智能体循环）与压缩功能调用提供方无关的流服务。 |
| `ctx.deepseekLlmApiExtensions` | `seam` | [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions) | [`session-log-deepseek`](../packages/session/session-log-deepseek), [`plugin-package-inventory-deepseek`](../packages/llm/plugin-package-inventory-deepseek) | [`llm-deepseek`](../packages/llm/llm-deepseek) | - | 插件准备彼此独立的顶层字段；官方适配器会合并这些字段，并在 HTTP 接受后提交其交付状态。 |
| `ctx.tokenMeter` | `core` | [`token-meter`](../packages/llm/token-meter) | - | [`compaction-basic`](../packages/compaction/compaction-basic) | - | 拥有按会话隔离的回放折叠区；压力消费方共享不可变且带修订版本的测量结果。 |
| `ctx.toolResultPruner` | `core` | [`compaction-tool-result-pruner`](../packages/compaction/compaction-tool-result-pruner) | - | [`compaction-basic`](../packages/compaction/compaction-basic) | - | 在摘要压缩前，通过可回放的单节点表层替换来改写过大的当前工具结果。 |
| `ctx.sessions` | `core` | [`session`](../packages/core/session) | - | [`agent-loop`](../packages/core/agent-loop), [`agent`](../packages/core/agent), [`session-persistence`](../packages/session/session-persistence), [`session-query`](../packages/session-query/session-query), [`session-query-sqlite`](../packages/session-query/session-query-sqlite), [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver), [`invariants`](../packages/runtime-diagnostics/invariants), [`message-feedback`](../packages/feedback/message-feedback) | - | 拥有仅追加的 Session 实例，并发出持久的会话事件流。 |
| `ctx.sessionController` | `core` | [`api-session-controller`](../packages/api/session-controller) | - | - | - | 负责 Session 命令、冷读取、持久事件跟随、实时控制状态、模型目录、workspace 打开与 Agent 激活策略。 |
| `ctx.sessionFileReferences` | `core` | [`api-session-controller`](../packages/api/session-controller) | - | - | - | 通过 Session Controller 的既有 Agent lookup 策略委托文件引用发现。 |
| `ctx.sessionSkillCatalog` | `core` | [`api-session-controller`](../packages/api/session-controller) | - | - | - | 在不激活冷 Agent 的前提下列出 Session 组合中允许用户调用的 skill。 |
| `ctx.credentialsController` | `core` | [`api-settings-controller`](../packages/api/settings-controller) | - | - | - | 把凭据引用 seam 投影到生成的 Remote namespace：批量扇出、视图投影与拒绝映射都在这里，而不在 seam Definition 上。 |
| `ctx.settingsController` | `core` | [`api-settings-controller`](../packages/api/settings-controller) | - | - | - | 把用户设置 seam 投影到生成的 Remote namespace：读取一律脱敏，所有拒绝在这里分类，而不在 seam Definition 上。 |
| `ctx.workspaceController` | `core` | [`api-workspace-controller`](../packages/api/workspace-controller) | - | - | - | 通过生成的 Remote namespace 负责 Workspace 命令和可在重连后收敛的 Workspace 状态投递。 |
| `ctx.directoryPickerController` | `core` | [`api-workspace-controller`](../packages/api/workspace-controller) | - | - | - | 把选目录 seam 送上线：能力门禁、取消传播，以及浏览器目录流程用于分支判断的 seam 错误码。 |
| `ctx.invariants` | `core` | [`invariants`](../packages/runtime-diagnostics/invariants) | - | [`session`](../packages/core/session), [`agent`](../packages/core/agent), [`scope`](../packages/core/scope), [`agent-loop`](../packages/core/agent-loop) | - | 配套子路径注册所属包本地的检查；该服务负责选择、唯一性、子 fiber，以及标明所属包的失败。 |
| `ctx.typert` | `core` | [`typert-registry`](../packages/typert/registry) | - | [`typert-loader`](../packages/typert/loader), [`api-gateway`](../packages/api/gateway) | - | 插件直接或通过 dsh-typert-loader 注册实时 zod 贡献；API 网关消费调用描述符和提供方，其他运行时消费方则在各自边界查询 schema 与反射元数据。 |
| `ctx.typertGateway` | `core` | [`api-gateway`](../packages/api/gateway) | - | - | - | 将生成的 Remote 描述符与实时 Cordis 服务关联，解析已注册的身份，并通过共享的 Connection RPC 载体提供一元调用。 |
| `ctx.sessionPersistence` | `seam` | [`session-persistence`](../packages/session/session-persistence) | [`session-persistence-jsonl`](../packages/session/session-persistence-jsonl) | [`agent-loop`](../packages/core/agent-loop), [`tool-bash`](../packages/shell/tool-bash), [`hooks-claude-code`](../packages/hooks/hooks-claude-code), [`hooks-codex`](../packages/hooks/hooks-codex), [`session-query`](../packages/session-query/session-query), [`session-query-sqlite`](../packages/session-query/session-query-sqlite), [`message-feedback`](../packages/feedback/message-feedback) | - | JSONL backend 把 SessionEvent 词汇持久化为每个 Session 一份产物。 |
| `ctx.settings` | `seam` | [`settings`](../packages/settings/settings) | [`settings-file`](../packages/settings/settings-file) | [`api-settings-controller`](../packages/api/settings-controller), [`llm-deepseek`](../packages/llm/llm-deepseek), [`llm-pi-ai`](../packages/llm/llm-pi-ai) | - | 插件注册命名空间 schema 并解析分层值；提供方存储原始文档。LLM（大语言模型）适配器在用户分区下将其入口配置注册为组合基础；settings controller 提供经过脱敏的分层描述符，并写入用户层。 |
| `ctx.subagentModelSelection` | `core` | [`tool-subagent`](../packages/subagent/tool-subagent) | - | [`tool-subagent`](../packages/subagent/tool-subagent) | - | 拥有默认关闭的设置命名空间；Agent 作用域的委派工具会在组合新顶层 Session 时读取它。 |
| `ctx.credentials` | `seam` | [`credentials`](../packages/credentials/credentials) | [`credentials-local`](../packages/credentials/credentials-local) | [`api-settings-controller`](../packages/api/settings-controller), [`llm-deepseek`](../packages/llm/llm-deepseek), [`llm-pi-ai`](../packages/llm/llm-pi-ai) | - | 配置携带对机密信息的引用；提供方拥有实际值。消费方按操作解析，因此轮换后的凭据会在紧接着的下一次请求中生效；settings controller 提供不含实际值的视图和只写存储。 |
| `ctx.authorization` | `seam` | [`authorization`](../packages/credentials/authorization) | - | [`llm-pi-ai`](../packages/llm/llm-pi-ai) | - | flow 由知道如何取得某份凭据的插件注册，并以其写入的记录为键；seam 拥有这段对话与"每个键同时只跑一次尝试"的生命周期，而非协议本身。 |
| `ctx.sessionTelemetry` | `seam` | [`session-telemetry`](../packages/session/session-telemetry) | [`session-telemetry-otel`](../packages/session/session-telemetry-otel) | - | - | 该 seam 捕获会话记录、进行脱敏并交给一个后端；没有其他组件消费该服务，其输出会离开当前进程。 |
| `ctx.storage` | `seam` | [`storage`](../packages/storage/storage) | [`storage-json`](../packages/storage/storage-json), [`storage-sqlite`](../packages/storage/storage-sqlite) | [`storage-domain`](../packages/storage/storage-domain) | - | 各后端以不同名称并列注册；数据形态（领域优先）挂载到枢纽上，并将类型化操作转换为不透明的 KV 单元原语。 |
| `ctx.storageDomain` | `core` | [`storage-domain`](../packages/storage/storage-domain) | - | [`workspace`](../packages/workspace/workspace), [`message-feedback`](../packages/feedback/message-feedback) | - | 等待所有已配置后端就绪，然后将领域形态发布为一个受生命周期约束的服务，用于类型化持久状态。 |
| `ctx.messageFeedback` | `core` | [`message-feedback`](../packages/feedback/message-feedback) | - | - | - | 拥有本地逐 assistant 消息反馈、生命周期与目标校验、逐条目 compare-and-set 及 Host 一元 Remote 契约，且不进入 Session 历史或遥测。 |
| `ctx.workspaceRegistry` | `core` | [`workspace`](../packages/workspace/workspace) | - | [`api-workspace-controller`](../packages/api/workspace-controller), [`api-session-controller`](../packages/api/session-controller) | - | 通过领域设施拥有带 WorkspaceId 品牌类型的记录；稳定的 sessionIds 账户驱动 Host RPC 与 GUI 投影。 |
| `ctx.sessionQuery` | `seam` | [`session-query`](../packages/session-query/session-query) | [`session-query-sqlite`](../packages/session-query/session-query-sqlite) | [`session-reference`](../packages/context/session-reference), [`tool-session-query`](../packages/session-query/tool-session-query) | - | 该接口提供精确读取、过滤和追踪；具体后端还提供全文协调、排序、摘要片段和游标世代，而模型消费方负责工作区权限与不含游标的渲染。 |
| `ctx.fileReferences` | `seam` | [`file-reference`](../packages/context/file-reference) | [`file-reference-local`](../packages/context/file-reference-local) | [`api-session-controller`](../packages/api/session-controller) | - | 该接口返回 Agent cwd 内仅含路径的补全候选；提供方负责命名空间访问与排序，但不读取文件内容。 |
| `ctx.sessionReferenceResolver` | `core` | [`session-reference`](../packages/context/session-reference) | - | - | - | 将当前表层中有界的对话快照投影为持久但不可信的消息上下文；Host 适配器负责提及语法。 |
| `ctx.sessionTitle` | `seam` | [`session-title`](../packages/session/session-title) | [`session-title-first-prompt-llm`](../packages/session/session-title-first-prompt-llm), [`session-title-all-prompts-llm`](../packages/session/session-title-all-prompts-llm) | - | - | 负责确定性回退、最新标题折叠区，以及唯一的可选异步提供方注册。 |
| `ctx.systemPrompt` | `core` | [`system-prompt`](../packages/core/system-prompt) | - | [`agent-loop`](../packages/core/agent-loop), [`tools`](../packages/core/tools), [`tool-fs`](../packages/fs/tool-fs), [`tool-terminal`](../packages/terminal/tool-terminal), [`tool-web`](../packages/web/tool-web) | - | 为每个步骤收集提示词各部分和面向模型的工具 schema。 |
| `ctx.tools` | `core` | [`tools`](../packages/core/tools) | - | [`agent-loop`](../packages/core/agent-loop), [`tool-ask-user`](../packages/interaction/tool-ask-user), [`tool-bash`](../packages/shell/tool-bash), [`tool-cordis`](../packages/extensions/tool-cordis), [`tool-fs`](../packages/fs/tool-fs), [`tool-terminal`](../packages/terminal/tool-terminal), [`tool-skill`](../packages/skill/tool-skill), [`tool-subagent`](../packages/subagent/tool-subagent), [`tool-todo`](../packages/todo/tool-todo), [`tool-web`](../packages/web/tool-web) | - | 注册能力，负责 PTC mode 传输，并让调用依次经过策略前处理、单调守卫、环绕分派、策略后处理和最终结果观测。 |
| `ctx.userQuestions` | `seam` | [`user-questions`](../packages/interaction/user-questions) | - | [`tool-ask-user`](../packages/interaction/tool-ask-user) | - | UI 前端提供当前生效的人工回答提供方；tool-ask-user 在提供方无关的 ask() promise 上暂停工具调用。 |
| `ctx.planMode` | `core` | [`plan-mode`](../packages/plan/plan-mode) | - | - | - | 折叠已记录的计划／模式状态，在轮次边界刷新用户选择，渲染由部署方拥有的指导信息，注册 /plan，并在状态转换期间保持计划退出 schema 稳定。 |
| `ctx.agentPresets` | `core` | [`agent-presets`](../packages/preset/agent-presets) | - | - | - | 在受信任根目录与用户创作根目录上发现 preset 目录，并在创建期把一份 preset cordis.yml 挂载到 agent 作用域之下，拒绝始终未激活或向根服务 realm 发布服务的行。 |
| `ctx.commands` | `core` | [`commands`](../packages/interaction/commands) | - | - | - | 插件注册直接面向人的命令，而不会把调用发送给模型。 |
| `ctx.sessionProjections` | `core` | [`session-projection`](../packages/session/session-projection) | - | [`api-session-controller`](../packages/api/session-controller), [`tool-todo`](../packages/todo/tool-todo), [`session-title`](../packages/session/session-title) | - | 各领域注册由状态驱动的折叠单元；主动驱动过程维护每个会话的水位状态，Session controller 提供 baseline 并推送发生变化的值。 |
| `ctx.sessionProjectionCache` | `core` | [`session-projection-cache`](../packages/session/session-projection-cache) | - | [`api-session-controller`](../packages/api/session-controller), [`session-query`](../packages/session-query/session-query), [`session-reference`](../packages/context/session-reference), [`subagent`](../packages/subagent/subagent) | - | 按会话持久保存投影单元状态的检查点（节流检查点，以及轮次／结束／分离时的必选检查点），并提供冷读取阶梯：缓存行加持久化尾部回放，因此列表读取永远不需要加载完整日志。 |
| `ctx.skills` | `seam` | [`skill`](../packages/skill/skill) | [`skill-badge`](../packages/skill/skill-badge), [`skill-filesystem`](../packages/skill/skill-filesystem) | [`tool-skill`](../packages/skill/tool-skill) | - | 合并提供方的 skill（技能）目录；tool-skill 渲染会话前缀目录，并加载完整的 skill 正文。 |
| `ctx.agents` | `core` | [`agent`](../packages/core/agent) | - | [`agent-loop`](../packages/core/agent-loop), [`acp`](../packages/acp/acp), [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver) | - | 拥有实时 Agent 句柄、创建／恢复工厂 seam，以及进程本地的发起方传播。 |
| `ctx.agentDefaultModel` | `core` | [`agent-default-model`](../packages/core/agent-default-model) | - | [`api-session-controller`](../packages/api/session-controller), [`headless`](../packages/bundle/headless) | - | 通过 settings 分层默认 `ModelSelection`，让直接入口与 Host 支撑的 Agent 入口共享同一个状态所有者。 |
| `ctx.agentLoop` | `bundle` | [`agent-loop`](../packages/core/agent-loop) | - | [`base`](../packages/bundle/base), [`sdk-minimal`](../packages/bundle/sdk-minimal) | - | 唯一的具体循环插件；扩展包依赖 dsh-agent 的事件和服务，而不依赖此包。 |
| `ctx.mcpServers` | `core` | [`mcp-manager`](../packages/mcp/mcp-manager) | - | - | - | 依据 mcp 设置命名空间对账 mcp-client 实例，聚合它们的连接状态，并向管理界面提供 restart 与 probe。 |
| `ctx.goals` | `core` | [`goal`](../packages/goal/goal) | - | - | - | 从会话日志折叠带修订版本的目标状态，并将实时延续激活保留在进程本地。 |
| `ctx.e2b` | `core` | [`e2b`](../packages/e2b/e2b) | - | [`fs-e2b`](../packages/e2b/fs-e2b), [`subprocess-e2b`](../packages/e2b/subprocess-e2b) | - | 拥有一个共享的 E2B SDK 句柄、远程工作目录和最终沙箱处置，使两个基础 E2B 提供方处于同一个 Linux 运行时中。 |
| `ctx.subprocess` | `seam` | [`subprocess`](../packages/subprocess/subprocess) | [`subprocess-local`](../packages/subprocess/subprocess-local), [`subprocess-e2b`](../packages/e2b/subprocess-e2b) | [`bash-local`](../packages/shell/bash-local), [`bash-sandbox`](../packages/shell/bash-sandbox), [`terminal-bash`](../packages/terminal/terminal-bash), [`lsp-stdio`](../packages/lsp/lsp-stdio), [`subagent-acp`](../packages/subagent/subagent-acp), [`subagent-codex`](../packages/subagent/subagent-codex), [`subagent-claude-code`](../packages/subagent/subagent-claude-code) | - | Bash 执行器、PTY shell 后端、LSP Host，以及进程外 ACP、Codex 和 Claude Code subagent 后端都通过 ctx.subprocess 执行 spawn；该服务负责进程坐标、进程树／会话生命周期、stdio 处置、终端机制和 kill 升级。 |
| `ctx.shell` | `seam` | [`shell`](../packages/shell/shell) | [`bash-local`](../packages/shell/bash-local), [`bash-sandbox`](../packages/shell/bash-sandbox), [`pwsh-local`](../packages/shell/pwsh-local) | [`tool-bash`](../packages/shell/tool-bash), [`tool-pwsh`](../packages/shell/tool-pwsh), [`hooks-claude-code`](../packages/hooks/hooks-claude-code), [`hooks-codex`](../packages/hooks/hooks-codex) | - | 面向模型的 shell 工具和钩子桥接消费此 seam；沙箱、远程或 PowerShell 执行器可以替换 bash-local，而无需改动这些消费方。 |
| `ctx.shellEnv` | `core` | [`shell-env`](../packages/shell/shell-env) | - | [`tool-bash`](../packages/shell/tool-bash), [`tool-pwsh`](../packages/shell/tool-pwsh) | - | 插件声明限定于 effect 作用域的 DSH_* 事实；每个 shell 工具在每次执行时收集一份可信快照，其执行器据此重建命名空间。 |
| `ctx.terminals` | `seam` | [`terminal`](../packages/terminal/terminal) | [`terminal-bash`](../packages/terminal/terminal-bash) | [`tool-terminal`](../packages/terminal/tool-terminal) | - | 注册表负责精确到 Agent 的会话身份和清理；后端负责终端机制，tool-terminal 则提供限定于所有者作用域的模型接口。 |
| `ctx.sandbox` | `seam` | [`sandbox`](../packages/sandbox/sandbox) | [`sandbox-local`](../packages/sandbox/sandbox-local) | [`bash-sandbox`](../packages/shell/bash-sandbox), [`terminal-bash`](../packages/terminal/terminal-bash) | - | 消费方交出即将执行 spawn 的确切 argv；与宿主共享文件系统和内核的后端按每次调用的策略包装该 argv，并报告强制执行情况。 |
| `ctx.sandboxPolicy` | `core` | [`sandbox-policy`](../packages/sandbox/sandbox-policy) | - | [`bash-sandbox`](../packages/shell/bash-sandbox), [`fs-sandbox`](../packages/fs/fs-sandbox), [`terminal-bash`](../packages/terminal/terminal-bash) | - | 统一保存部署默认模式和工作区根目录；只有沙箱执行器和提供方读取该服务（工具层使用它同时导出的纯 `sandbox/mode` 折叠区）。两类强制执行组件都读取该服务，因此 bash 与 fs 不会限制到不同的根目录。 |
| `ctx.approval` | `seam` | [`user-approval`](../packages/interaction/user-approval) | - | [`tools`](../packages/core/tools), [`tool-bash`](../packages/shell/tool-bash), [`acp`](../packages/acp/acp) | - | 一次性权限决策通过 `approval/request` waterfall（瀑布式事件）分派；回答方是监听器（即 ACP 为自身 agent 提供的桥接），没有回答方时以 `unavailable` 关闭失败。 |
| `ctx.permissionPresets` | `core` | [`permission-presets`](../packages/interaction/permission-presets) | - | - | - | 面向用户的预设表（`workspace-write`／`danger-full-access`），将沙箱模式与审批策略选项组合在一起；一次切换会写入一个 `permission/preset` 事件，并贯通到两个选项事件。 |
| `ctx.codeRuntime` | `seam` | [`code-runtime`](../packages/code-runtime/code-runtime) | [`code-runtime-worker-thread`](../packages/code-runtime/code-runtime-worker-thread), [`experimental-code-runtime-python`](../packages/experimental/code-runtime-python) | [`tools`](../packages/core/tools) | - | 使用 Host 提供的异步绑定运行一段由模型编写的程序；各后端采用不同的基础环境和语言（工具注册表在 PTC mode 下消费该服务）。 |
| `ctx.fs` | `seam` | [`fs`](../packages/fs/fs) | [`fs-local`](../packages/fs/fs-local), [`fs-sandbox`](../packages/fs/fs-sandbox), [`fs-e2b`](../packages/e2b/fs-e2b) | [`tool-fs`](../packages/fs/tool-fs) | [`fs-observation-policy`](../packages/fs/fs-observation-policy) | tool-fs 通过 ctx.fs 执行读取／写入／编辑；fs-sandbox 按共享沙箱模式限制变更；fs-observation-policy 通过 fs/* 事件门禁贡献基于观测状态的检查。 |
| `ctx.compaction` | `seam` | [`compaction`](../packages/compaction/compaction) | [`compaction-basic`](../packages/compaction/compaction-basic) | [`compaction-basic`](../packages/compaction/compaction-basic) | - | 基础后端消费步骤后的压力事件和请求错误恢复事件；不存在面向模型的压缩工具。 |
| `ctx.subagents` | `seam` | [`subagent`](../packages/subagent/subagent) | [`subagent-spawn-in-process`](../packages/subagent/subagent-spawn-in-process), [`subagent-fork-in-process`](../packages/subagent/subagent-fork-in-process), [`subagent-acp`](../packages/subagent/subagent-acp), [`subagent-codex`](../packages/subagent/subagent-codex), [`subagent-claude-code`](../packages/subagent/subagent-claude-code), [`subagent-dsh-sdk`](../packages/subagent/subagent-dsh-sdk) | [`tool-subagent`](../packages/subagent/tool-subagent), [`tool-subagent-control`](../packages/subagent/tool-subagent-control), [`tool-ralph`](../packages/workflow/tool-ralph) | - | 提供方实现传输；该服务还负责可选的、基于 Activation 的延续编排，tool-subagent 选择一次性或可延续委派，tool-subagent-control 传递后续消息，而 tool-ralph 要求一条全新的结构化输出路由。 |
| `ctx.agentTeams` | `core` | [`experimental-agent-team`](../packages/experimental/agent-team) | - | [`experimental-tool-agent-team`](../packages/experimental/tool-agent-team), [`experimental-client-ui-agent-team`](../packages/experimental/client-ui-agent-team) | - | 负责隐式 Root roster、持久 peer mailbox、共享任务 DAG、continuable child 生命周期与生成式 Team Remote method；tool-agent-team 提供模型控制工具，client-ui-agent-team 挂载浏览器 contribution。 |
| `ctx.inspector` | `core` | `inspector` | - | - | - | 负责 Worker 托管的 CDP target，以及独立于传输的 Host 和 Client observation 与 Cordis tree query API。 |
| `ctx.jobs` | `seam` | [`jobs`](../packages/jobs/jobs) | [`jobs-local`](../packages/jobs/jobs-local) | [`tool-bash`](../packages/shell/tool-bash), [`tool-terminal`](../packages/terminal/tool-terminal), [`tool-subagent`](../packages/subagent/tool-subagent), [`tool-jobs`](../packages/jobs/tool-jobs) | - | 生产方（后台 bash、PTY 发送和 subagent 委派）登记正在运行的工作；tool-jobs 是面向模型的控制器，用于读取、列出和终止这些工作；jobs-local 是进程本地注册表。 |
| `ctx.web` | `seam` | [`web`](../packages/web/web) | [`web-search-exa`](../packages/web/web-search-exa), [`web-search-perplexity`](../packages/web/web-search-perplexity), [`web-search-deepseek`](../packages/web/web-search-deepseek), [`web-fetch-http`](../packages/web/web-fetch-http) | [`tool-web`](../packages/web/tool-web) | - | 搜索和抓取提供方注册到同一个 ctx.web seam；tool-web 负责稳定的面向模型名称。 |
| `ctx.spillStore` | `seam` | [`spill`](../packages/spill/spill) | [`spill-local`](../packages/spill/spill-local) | [`spill-policy`](../packages/spill/spill-policy) | - | 后端保存过大的工具文本，并返回面向模型的定位信息和取回提示；spill-policy 是 tools/post-execute 消费方，负责决定何时 spill。 |
| `ctx.directoryPicker` | `seam` | [`host-directory-picker`](../packages/host/directory-picker) | [`host-directory-picker-native`](../packages/host/directory-picker-native), [`host-directory-picker-browse`](../packages/host/directory-picker-browse) | [`api-workspace-controller`](../packages/api/workspace-controller) | - | 带判别标记的交互能力：原生后端在 Host 显示设备上打开一个操作系统选择器，浏览后端为应用内浏览器提供列表与创建原语；双端后端通过其浏览器侧填充 ui-workspace 目录流程的 slot（不通过协议发布）。 |
| `ctx.webServer` | `core` | [`host-webserver`](../packages/host/webserver) | - | [`client-connection`](../packages/client/connection), [`client-modules`](../packages/client/modules), [`client-hmr`](../packages/client/hmr) | - | 普通的 node:http 载体：具名路由注册表、索引转换 tap，以及静态 dist 回退；Web 传输插件注册自己的路由。 |
| `ctx.clientModules` | `core` | [`client-modules`](../packages/client/modules) | - | [`client-hmr`](../packages/client/hmr) | - | 通过增量 `dsh.client` 扫描组合 __DSH_BOOT__ 入口图，提供插件组合包，并通知重建／图变更订阅方。 |
| `ctx.workflowEngine` | `seam` | [`workflow`](../packages/workflow/workflow) | [`workflow-worker-thread`](../packages/workflow/workflow-worker-thread) | [`tool-workflow`](../packages/workflow/tool-workflow), [`tool-ralph`](../packages/workflow/tool-ralph) | - | 每个上下文使用一个引擎，与 bash 相同，且没有具名提供方注册表；通用工作流与固定 Ralph 消费方启动运行，其中的 agent() 调用通过 ctx.subagents 扇出。 |
| `ctx.webhookRuntime` | `core` | [`webhook`](../packages/webhook/webhook) | - | [`webhook-github`](../packages/webhook/webhook-github) | - | 提供方适配器分派已认证交付；可信插件注册独立的进程本地规则，runtime 把非 null 结果转换为普通的 Workspace-backed Session，不保留交付或完成状态。 |
| `ctx.lsp` | `seam` | [`lsp`](../packages/lsp/lsp) | [`lsp-stdio`](../packages/lsp/lsp-stdio) | [`tool-lsp`](../packages/lsp/tool-lsp) | - | 提供方注册与选择，加上恰好四种操作的标准化查询执行；该 seam 不提供协议逃生口，后端必须转换为标准化请求和结果。 |
| `ctx.dynamicCordisRunner` | `core` | [`cordis-host-runner`](../packages/extensions/cordis-host-runner) | - | [`tool-cordis`](../packages/extensions/tool-cordis) | - | 拥有内存定义注册表、Host 半的 vm 沙箱和 request-run 往返流程；浏览器页面通过其 Remote 命名空间在线访问同一服务。 |
| `ctx.cordisInspect` | `core` | [`cordis-host-runner`](../packages/extensions/cordis-host-runner) | - | [`tool-cordis`](../packages/extensions/tool-cordis) | - | 注册 Host inspect 提供方、镜像 Client 提供方 manifest，并通过动态 Cordis 传输路由 Client 查询。 |

维护模式：混合模式。服务从 Cordis 声明中发现；接口、实现和消费方角色在 `scripts/gen-doc-graphs.ts` 中分类，并设有完整性守卫。
