<!-- 由 scripts/gen-module-graph.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-module-graph` 重新生成。 -->

# 共享实例依赖关系图

[English](module-graph.md) | 中文

`@deepseek-ai/dsh-*` harness 包之间的 peer 依赖关系。peer 表示消费端需要提供共享实例，不包括普通运行时 dependency 或仅开发期关系。该图按 `packages/<group>/<pkg>` 层级分组；边 `a --> b` 表示包 `a` peer 依赖包 `b`。名称中的 `@deepseek-ai/dsh-` 前缀已移除。

```mermaid
flowchart TD
  subgraph group_util["packages/util"]
    pkg_atomic_write["atomic-write"]
    pkg_brand["brand"]
    pkg_deque["deque"]
    pkg_home_paths["home-paths"]
    pkg_http_proxy["http-proxy"]
    pkg_launch_environment["launch-environment"]
    pkg_native_command["native-command"]
    pkg_output_retention["output-retention"]
    pkg_timeout["timeout"]
    pkg_util_crypto["util-crypto"]
    pkg_util_time["util-time"]
    pkg_util_values["util-values"]
    pkg_util_workspace_path["util-workspace-path"]
  end
  subgraph group_llm["packages/llm"]
    pkg_deepseek_llm_api_extensions["deepseek-llm-api-extensions"]
    pkg_llm["llm"]
    pkg_llm_deepseek["llm-deepseek"]
    pkg_llm_pi_ai["llm-pi-ai"]
    pkg_llm_retry["llm-retry"]
    pkg_plugin_package_inventory_deepseek["plugin-package-inventory-deepseek"]
    pkg_token_meter["token-meter"]
  end
  subgraph group_core["packages/core"]
    pkg_agent["agent"]
    pkg_agent_default_model["agent-default-model"]
    pkg_agent_loop["agent-loop"]
    pkg_agent_tool_presentation["agent-tool-presentation"]
    pkg_scope["scope"]
    pkg_session["session"]
    pkg_system_prompt["system-prompt"]
    pkg_tools["tools"]
  end
  subgraph group_goal["packages/goal"]
    pkg_command_goal["command-goal"]
    pkg_goal["goal"]
    pkg_goal_round_driver["goal-round-driver"]
    pkg_tool_goal["tool-goal"]
  end
  subgraph group_fs["packages/fs"]
    pkg_fs["fs"]
    pkg_fs_local["fs-local"]
    pkg_fs_observation_policy["fs-observation-policy"]
    pkg_fs_sandbox["fs-sandbox"]
    pkg_tool_fs["tool-fs"]
    pkg_tool_fs_search["tool-fs-search"]
    pkg_tool_str_replace_editor["tool-str-replace-editor"]
  end
  subgraph group_skill["packages/skill"]
    pkg_skill["skill"]
    pkg_skill_badge["skill-badge"]
    pkg_skill_filesystem["skill-filesystem"]
    pkg_tool_skill["tool-skill"]
  end
  subgraph group_subagent["packages/subagent"]
    pkg_subagent["subagent"]
    pkg_subagent_acp["subagent-acp"]
    pkg_subagent_claude_code["subagent-claude-code"]
    pkg_subagent_codex["subagent-codex"]
    pkg_subagent_dsh_sdk["subagent-dsh-sdk"]
    pkg_subagent_fork_in_process["subagent-fork-in-process"]
    pkg_subagent_in_process_driver["subagent-in-process-driver"]
    pkg_subagent_spawn_in_process["subagent-spawn-in-process"]
    pkg_tool_subagent["tool-subagent"]
    pkg_tool_subagent_control["tool-subagent-control"]
  end
  subgraph group_web["packages/web"]
    pkg_tool_web["tool-web"]
    pkg_web["web"]
    pkg_web_fetch_http["web-fetch-http"]
    pkg_web_search_deepseek["web-search-deepseek"]
    pkg_web_search_exa["web-search-exa"]
    pkg_web_search_perplexity["web-search-perplexity"]
  end
  subgraph group_spill["packages/spill"]
    pkg_spill["spill"]
    pkg_spill_local["spill-local"]
    pkg_spill_policy["spill-policy"]
  end
  subgraph group_todo["packages/todo"]
    pkg_tool_todo["tool-todo"]
  end
  subgraph group_plan["packages/plan"]
    pkg_plan_mode["plan-mode"]
  end
  subgraph group_hooks["packages/hooks"]
    pkg_hook_protocol["hook-protocol"]
    pkg_hooks_claude_code["hooks-claude-code"]
    pkg_hooks_codex["hooks-codex"]
  end
  subgraph group_session_query["packages/session-query"]
    pkg_session_log_export["session-log-export"]
    pkg_session_query["session-query"]
    pkg_session_query_sqlite["session-query-sqlite"]
    pkg_tool_session_query["tool-session-query"]
  end
  subgraph group_acp["packages/acp"]
    pkg_acp["acp"]
  end
  subgraph group_api["packages/api"]
    pkg_api_gateway["api-gateway"]
    pkg_api_remotes["api-remotes"]
    pkg_api_session_controller["api-session-controller"]
    pkg_api_settings_controller["api-settings-controller"]
    pkg_api_workspace_controller["api-workspace-controller"]
  end
  subgraph group_attachment["packages/attachment"]
    pkg_attachment["attachment"]
    pkg_attachment_local["attachment-local"]
  end
  subgraph group_boot["packages/boot"]
    pkg_app_boot["app-boot"]
    pkg_cmdline["cmdline"]
  end
  subgraph group_bundle["packages/bundle"]
    pkg_acp_app["acp-app"]
    pkg_base["base"]
    pkg_headless["headless"]
    pkg_sdk_app["sdk-app"]
    pkg_sdk_minimal["sdk-minimal"]
    pkg_web_app["web-app"]
  end
  subgraph group_client["packages/client"]
    pkg_client_connection["client-connection"]
    pkg_client_file_upload["client-file-upload"]
    pkg_client_hmr["client-hmr"]
    pkg_client_locale["client-locale"]
    pkg_client_modules["client-modules"]
    pkg_client_store["client-store"]
    pkg_client_ui_agent_preset["client-ui-agent-preset"]
    pkg_client_ui_approval["client-ui-approval"]
    pkg_client_ui_attachment["client-ui-attachment"]
    pkg_client_ui_brand_official["client-ui-brand-official"]
    pkg_client_ui_chat["client-ui-chat"]
    pkg_client_ui_commands["client-ui-commands"]
    pkg_client_ui_conversation["client-ui-conversation"]
    pkg_client_ui_deliverables["client-ui-deliverables"]
    pkg_client_ui_directory_picker_browse["client-ui-directory-picker-browse"]
    pkg_client_ui_directory_picker_native["client-ui-directory-picker-native"]
    pkg_client_ui_goal["client-ui-goal"]
    pkg_client_ui_input_trigger["client-ui-input-trigger"]
    pkg_client_ui_jobs["client-ui-jobs"]
    pkg_client_ui_layout["client-ui-layout"]
    pkg_client_ui_message_feedback["client-ui-message-feedback"]
    pkg_client_ui_model_selection["client-ui-model-selection"]
    pkg_client_ui_permission_presets["client-ui-permission-presets"]
    pkg_client_ui_plan["client-ui-plan"]
    pkg_client_ui_primitives["client-ui-primitives"]
    pkg_client_ui_reference["client-ui-reference"]
    pkg_client_ui_renderer["client-ui-renderer"]
    pkg_client_ui_schedule["client-ui-schedule"]
    pkg_client_ui_session["client-ui-session"]
    pkg_client_ui_settings["client-ui-settings"]
    pkg_client_ui_settings_general["client-ui-settings-general"]
    pkg_client_ui_settings_models["client-ui-settings-models"]
    pkg_client_ui_settings_plugin_inventory["client-ui-settings-plugin-inventory"]
    pkg_client_ui_settings_plugins["client-ui-settings-plugins"]
    pkg_client_ui_sidebar["client-ui-sidebar"]
    pkg_client_ui_skill["client-ui-skill"]
    pkg_client_ui_slots["client-ui-slots"]
    pkg_client_ui_subagent["client-ui-subagent"]
    pkg_client_ui_theme["client-ui-theme"]
    pkg_client_ui_tool["client-ui-tool"]
    pkg_client_ui_trajectory["client-ui-trajectory"]
    pkg_client_ui_user_questions["client-ui-user-questions"]
    pkg_client_ui_workflow_run["client-ui-workflow-run"]
    pkg_client_ui_workspace["client-ui-workspace"]
    pkg_client_web["client-web"]
  end
  subgraph group_code_runtime["packages/code-runtime"]
    pkg_code_runtime["code-runtime"]
    pkg_code_runtime_worker_thread["code-runtime-worker-thread"]
  end
  subgraph group_compaction["packages/compaction"]
    pkg_command_compact["command-compact"]
    pkg_compaction["compaction"]
    pkg_compaction_basic["compaction-basic"]
    pkg_compaction_tool_result_pruner["compaction-tool-result-pruner"]
  end
  subgraph group_context["packages/context"]
    pkg_agent_instructions["agent-instructions"]
    pkg_file_reference["file-reference"]
    pkg_file_reference_local["file-reference-local"]
    pkg_session_reference["session-reference"]
    pkg_time_context["time-context"]
    pkg_tmux_context["tmux-context"]
  end
  subgraph group_credentials["packages/credentials"]
    pkg_authorization["authorization"]
    pkg_credentials["credentials"]
    pkg_credentials_local["credentials-local"]
  end
  subgraph group_e2b["packages/e2b"]
    pkg_e2b["e2b"]
    pkg_fs_e2b["fs-e2b"]
    pkg_subprocess_e2b["subprocess-e2b"]
  end
  subgraph group_experimental["packages/experimental"]
    pkg_experimental_agent_team["experimental-agent-team"]
    pkg_experimental_agent_team_profile["experimental-agent-team-profile"]
    pkg_experimental_agent_team_web_profile["experimental-agent-team-web-profile"]
    pkg_experimental_client_ui_agent_team["experimental-client-ui-agent-team"]
    pkg_experimental_code_runtime_python["experimental-code-runtime-python"]
    pkg_experimental_inspector["experimental-inspector"]
    pkg_experimental_tool_agent_team["experimental-tool-agent-team"]
    pkg_experimental_webworker_packer["experimental-webworker-packer"]
    pkg_experimental_webworker_runtime["experimental-webworker-runtime"]
  end
  subgraph group_extensions["packages/extensions"]
    pkg_client_ui_cordis["client-ui-cordis"]
    pkg_cordis_client_runner["cordis-client-runner"]
    pkg_cordis_host_runner["cordis-host-runner"]
    pkg_tool_cordis["tool-cordis"]
  end
  subgraph group_feedback["packages/feedback"]
    pkg_command_feedback["command-feedback"]
    pkg_message_feedback["message-feedback"]
  end
  subgraph group_guard["packages/guard"]
    pkg_repeat_tool_reminder["repeat-tool-reminder"]
    pkg_tool_call_timeout_policy["tool-call-timeout-policy"]
  end
  subgraph group_host["packages/host"]
    pkg_host_directory_picker["host-directory-picker"]
    pkg_host_directory_picker_auto["host-directory-picker-auto"]
    pkg_host_directory_picker_browse["host-directory-picker-browse"]
    pkg_host_directory_picker_native["host-directory-picker-native"]
    pkg_host_frontend_static["host-frontend-static"]
    pkg_host_plugin_inventory["host-plugin-inventory"]
    pkg_host_webserver["host-webserver"]
  end
  subgraph group_identity["packages/identity"]
    pkg_anonymous_user_id["anonymous-user-id"]
  end
  subgraph group_interaction["packages/interaction"]
    pkg_commands["commands"]
    pkg_permission_presets["permission-presets"]
    pkg_tool_ask_user["tool-ask-user"]
    pkg_user_approval["user-approval"]
    pkg_user_questions["user-questions"]
  end
  subgraph group_jobs["packages/jobs"]
    pkg_jobs["jobs"]
    pkg_jobs_local["jobs-local"]
    pkg_tool_jobs["tool-jobs"]
  end
  subgraph group_lsp["packages/lsp"]
    pkg_lsp["lsp"]
    pkg_lsp_stdio["lsp-stdio"]
    pkg_tool_lsp["tool-lsp"]
  end
  subgraph group_mcp["packages/mcp"]
    pkg_mcp_client["mcp-client"]
    pkg_mcp_manager["mcp-manager"]
  end
  subgraph group_preset["packages/preset"]
    pkg_agent_presets["agent-presets"]
    pkg_persona["persona"]
  end
  subgraph group_runtime_diagnostics["packages/runtime-diagnostics"]
    pkg_invariants["invariants"]
  end
  subgraph group_sandbox["packages/sandbox"]
    pkg_sandbox["sandbox"]
    pkg_sandbox_local["sandbox-local"]
    pkg_sandbox_policy["sandbox-policy"]
    pkg_sandbox_windows_acl["sandbox-windows-acl"]
  end
  subgraph group_schedule["packages/schedule"]
    pkg_schedule["schedule"]
  end
  subgraph group_sdk["packages/sdk"]
    pkg_sdk_client["sdk-client"]
    pkg_sdk_jsonrpc_server["sdk-jsonrpc-server"]
    pkg_sdk_protocol["sdk-protocol"]
  end
  subgraph group_session["packages/session"]
    pkg_session_checkpoint_policy["session-checkpoint-policy"]
    pkg_session_format["session-format"]
    pkg_session_format_catalog["session-format-catalog"]
    pkg_session_format_v0_to_v1["session-format-v0-to-v1"]
    pkg_session_format_v1_to_v2["session-format-v1-to-v2"]
    pkg_session_log_deepseek["session-log-deepseek"]
    pkg_session_persistence["session-persistence"]
    pkg_session_persistence_jsonl["session-persistence-jsonl"]
    pkg_session_projection["session-projection"]
    pkg_session_projection_cache["session-projection-cache"]
    pkg_session_stats["session-stats"]
    pkg_session_telemetry["session-telemetry"]
    pkg_session_telemetry_otel["session-telemetry-otel"]
    pkg_session_title["session-title"]
    pkg_session_title_all_prompts_llm["session-title-all-prompts-llm"]
    pkg_session_title_first_prompt_llm["session-title-first-prompt-llm"]
    pkg_session_title_llm["session-title-llm"]
    pkg_session_turn_outline["session-turn-outline"]
  end
  subgraph group_settings["packages/settings"]
    pkg_settings["settings"]
    pkg_settings_file["settings-file"]
  end
  subgraph group_shell["packages/shell"]
    pkg_bash_local["bash-local"]
    pkg_bash_sandbox["bash-sandbox"]
    pkg_pwsh_local["pwsh-local"]
    pkg_pwsh_sandbox["pwsh-sandbox"]
    pkg_shell["shell"]
    pkg_shell_env["shell-env"]
    pkg_tool_bash["tool-bash"]
    pkg_tool_bash_persistent["tool-bash-persistent"]
    pkg_tool_pwsh["tool-pwsh"]
    pkg_tool_pwsh_persistent["tool-pwsh-persistent"]
  end
  subgraph group_storage["packages/storage"]
    pkg_storage["storage"]
    pkg_storage_domain["storage-domain"]
    pkg_storage_json["storage-json"]
    pkg_storage_sqlite["storage-sqlite"]
  end
  subgraph group_subprocess["packages/subprocess"]
    pkg_subprocess["subprocess"]
    pkg_subprocess_local["subprocess-local"]
    pkg_win32_process["win32-process"]
  end
  subgraph group_terminal["packages/terminal"]
    pkg_terminal["terminal"]
    pkg_terminal_bash["terminal-bash"]
    pkg_tool_terminal["tool-terminal"]
  end
  subgraph group_test_support["packages/test-support"]
    pkg_agent_loop_testkit["agent-loop-testkit"]
    pkg_client_test_runtime["client-test-runtime"]
    pkg_llm_mock_server["llm-mock-server"]
    pkg_llm_replay["llm-replay"]
    pkg_loader_smoke["loader-smoke"]
    pkg_session_snapshot["session-snapshot"]
  end
  subgraph group_typert["packages/typert"]
    pkg_typert_generator["typert-generator"]
    pkg_typert_loader["typert-loader"]
    pkg_typert_protocol["typert-protocol"]
    pkg_typert_registry["typert-registry"]
  end
  subgraph group_webhook["packages/webhook"]
    pkg_webhook["webhook"]
    pkg_webhook_github["webhook-github"]
  end
  subgraph group_workflow["packages/workflow"]
    pkg_tool_ralph["tool-ralph"]
    pkg_tool_workflow["tool-workflow"]
    pkg_workflow["workflow"]
    pkg_workflow_worker_thread["workflow-worker-thread"]
  end
  subgraph group_workspace["packages/workspace"]
    pkg_workspace["workspace"]
  end
  pkg_scope --> pkg_invariants
  pkg_web --> pkg_llm
  pkg_attachment --> pkg_brand
  pkg_credentials --> pkg_invariants
  pkg_e2b --> pkg_http_proxy
  pkg_experimental_code_runtime_python --> pkg_code_runtime
  pkg_experimental_code_runtime_python --> pkg_timeout
  pkg_experimental_code_runtime_python --> pkg_util_values
  pkg_experimental_inspector --> pkg_client_modules
  pkg_experimental_inspector --> pkg_host_webserver
  pkg_experimental_webworker_runtime --> pkg_client_connection
  pkg_experimental_webworker_runtime --> pkg_client_modules
  pkg_experimental_webworker_runtime --> pkg_host_webserver
  pkg_host_directory_picker_auto --> pkg_client_ui_directory_picker_browse
  pkg_host_directory_picker_auto --> pkg_client_ui_directory_picker_native
  pkg_host_directory_picker_auto --> pkg_host_directory_picker_browse
  pkg_host_directory_picker_auto --> pkg_host_directory_picker_native
  pkg_host_directory_picker_auto --> pkg_host_webserver
  pkg_host_frontend_static --> pkg_client_connection
  pkg_host_frontend_static --> pkg_host_webserver
  pkg_anonymous_user_id --> pkg_brand
  pkg_anonymous_user_id --> pkg_home_paths
  pkg_lsp --> pkg_brand
  pkg_lsp --> pkg_llm
  pkg_storage_domain --> pkg_invariants
  pkg_storage_domain --> pkg_storage
  pkg_storage_json --> pkg_storage
  pkg_storage_sqlite --> pkg_storage
  pkg_subprocess --> pkg_http_proxy
  pkg_typert_loader --> pkg_typert_registry
  pkg_session --> pkg_scope
  pkg_system_prompt --> pkg_invariants
  pkg_system_prompt --> pkg_llm
  pkg_system_prompt --> pkg_scope
  pkg_skill --> pkg_llm
  pkg_skill --> pkg_scope
  pkg_web_fetch_http --> pkg_http_proxy
  pkg_web_fetch_http --> pkg_timeout
  pkg_web_fetch_http --> pkg_web
  pkg_web_search_exa --> pkg_launch_environment
  pkg_web_search_exa --> pkg_web
  pkg_web_search_perplexity --> pkg_launch_environment
  pkg_web_search_perplexity --> pkg_web
  pkg_api_remotes --> pkg_scope
  pkg_attachment_local --> pkg_attachment
  pkg_attachment_local --> pkg_home_paths
  pkg_client_file_upload --> pkg_scope
  pkg_authorization --> pkg_credentials
  pkg_authorization --> pkg_invariants
  pkg_authorization --> pkg_llm
  pkg_credentials_local --> pkg_atomic_write
  pkg_credentials_local --> pkg_credentials
  pkg_credentials_local --> pkg_home_paths
  pkg_credentials_local --> pkg_launch_environment
  pkg_subprocess_e2b --> pkg_e2b
  pkg_subprocess_e2b --> pkg_subprocess
  pkg_subprocess_e2b --> pkg_timeout
  pkg_subprocess_local --> pkg_subprocess
  pkg_subprocess_local --> pkg_timeout
  pkg_skill_badge --> pkg_skill
  pkg_spill --> pkg_brand
  pkg_spill --> pkg_llm
  pkg_spill --> pkg_session
  pkg_app_boot --> pkg_home_paths
  pkg_app_boot --> pkg_launch_environment
  pkg_app_boot --> pkg_system_prompt
  pkg_code_runtime_worker_thread --> pkg_code_runtime
  pkg_code_runtime_worker_thread --> pkg_session
  pkg_code_runtime_worker_thread --> pkg_timeout
  pkg_persona --> pkg_system_prompt
  pkg_sandbox --> pkg_llm
  pkg_sandbox --> pkg_session
  pkg_session_format_catalog --> pkg_session
  pkg_session_log_deepseek --> pkg_deepseek_llm_api_extensions
  pkg_session_log_deepseek --> pkg_invariants
  pkg_session_log_deepseek --> pkg_session
  pkg_session_persistence --> pkg_brand
  pkg_session_persistence --> pkg_session
  pkg_session_persistence --> pkg_timeout
  pkg_session_projection --> pkg_session
  pkg_settings --> pkg_brand
  pkg_settings --> pkg_invariants
  pkg_settings --> pkg_session
  pkg_session_snapshot --> pkg_http_proxy
  pkg_session_snapshot --> pkg_session
  pkg_agent --> pkg_invariants
  pkg_agent --> pkg_llm
  pkg_agent --> pkg_scope
  pkg_agent --> pkg_session
  pkg_agent --> pkg_session_projection
  pkg_agent --> pkg_system_prompt
  pkg_agent --> pkg_typert_protocol
  pkg_fs --> pkg_brand
  pkg_fs --> pkg_invariants
  pkg_fs --> pkg_llm
  pkg_fs --> pkg_sandbox
  pkg_spill_local --> pkg_spill
  pkg_session_log_export --> pkg_session
  pkg_session_log_export --> pkg_session_persistence
  pkg_message_feedback --> pkg_brand
  pkg_message_feedback --> pkg_llm
  pkg_message_feedback --> pkg_session
  pkg_message_feedback --> pkg_session_persistence
  pkg_message_feedback --> pkg_storage_domain
  pkg_message_feedback --> pkg_typert_protocol
  pkg_sandbox_local --> pkg_llm
  pkg_sandbox_local --> pkg_sandbox
  pkg_sandbox_local --> pkg_session
  pkg_session_persistence_jsonl --> pkg_session
  pkg_session_persistence_jsonl --> pkg_session_persistence
  pkg_session_projection_cache --> pkg_session
  pkg_session_projection_cache --> pkg_session_projection
  pkg_session_projection_cache --> pkg_storage_domain
  pkg_session_stats --> pkg_llm
  pkg_session_stats --> pkg_session
  pkg_session_stats --> pkg_session_projection
  pkg_session_turn_outline --> pkg_llm
  pkg_session_turn_outline --> pkg_session
  pkg_session_turn_outline --> pkg_session_projection
  pkg_settings_file --> pkg_atomic_write
  pkg_settings_file --> pkg_home_paths
  pkg_settings_file --> pkg_settings
  pkg_shell --> pkg_sandbox
  pkg_shell --> pkg_settings
  pkg_shell --> pkg_subprocess
  pkg_workspace --> pkg_invariants
  pkg_workspace --> pkg_session
  pkg_workspace --> pkg_session_persistence
  pkg_workspace --> pkg_storage
  pkg_workspace --> pkg_storage_domain
  pkg_workspace --> pkg_typert_protocol
  pkg_llm_deepseek --> pkg_anonymous_user_id
  pkg_llm_deepseek --> pkg_atomic_write
  pkg_llm_deepseek --> pkg_attachment
  pkg_llm_deepseek --> pkg_credentials
  pkg_llm_deepseek --> pkg_deepseek_llm_api_extensions
  pkg_llm_deepseek --> pkg_fs
  pkg_llm_deepseek --> pkg_home_paths
  pkg_llm_deepseek --> pkg_launch_environment
  pkg_llm_deepseek --> pkg_llm
  pkg_llm_deepseek --> pkg_settings
  pkg_llm_deepseek --> pkg_timeout
  pkg_llm_pi_ai --> pkg_attachment
  pkg_llm_pi_ai --> pkg_authorization
  pkg_llm_pi_ai --> pkg_credentials
  pkg_llm_pi_ai --> pkg_fs
  pkg_llm_pi_ai --> pkg_launch_environment
  pkg_llm_pi_ai --> pkg_llm
  pkg_llm_pi_ai --> pkg_settings
  pkg_llm_pi_ai --> pkg_timeout
  pkg_llm_retry --> pkg_agent
  pkg_llm_retry --> pkg_brand
  pkg_llm_retry --> pkg_invariants
  pkg_llm_retry --> pkg_llm
  pkg_llm_retry --> pkg_session
  pkg_llm_retry --> pkg_session_projection
  pkg_llm_retry --> pkg_timeout
  pkg_agent_default_model --> pkg_agent
  pkg_agent_default_model --> pkg_llm
  pkg_agent_default_model --> pkg_settings
  pkg_goal --> pkg_agent
  pkg_goal --> pkg_brand
  pkg_goal --> pkg_invariants
  pkg_goal --> pkg_llm
  pkg_goal --> pkg_scope
  pkg_goal --> pkg_session
  pkg_goal --> pkg_session_projection
  pkg_goal --> pkg_typert_protocol
  pkg_fs_local --> pkg_fs
  pkg_fs_observation_policy --> pkg_fs
  pkg_skill_filesystem --> pkg_fs
  pkg_skill_filesystem --> pkg_home_paths
  pkg_skill_filesystem --> pkg_skill
  pkg_web_search_deepseek --> pkg_agent
  pkg_web_search_deepseek --> pkg_credentials
  pkg_web_search_deepseek --> pkg_launch_environment
  pkg_web_search_deepseek --> pkg_session
  pkg_web_search_deepseek --> pkg_settings
  pkg_web_search_deepseek --> pkg_web
  pkg_hook_protocol --> pkg_invariants
  pkg_hook_protocol --> pkg_session
  pkg_hook_protocol --> pkg_shell
  pkg_api_workspace_controller --> pkg_api_gateway
  pkg_api_workspace_controller --> pkg_client_connection
  pkg_api_workspace_controller --> pkg_host_directory_picker
  pkg_api_workspace_controller --> pkg_session
  pkg_api_workspace_controller --> pkg_storage_domain
  pkg_api_workspace_controller --> pkg_typert_protocol
  pkg_api_workspace_controller --> pkg_workspace
  pkg_file_reference --> pkg_agent
  pkg_time_context --> pkg_agent
  pkg_time_context --> pkg_invariants
  pkg_time_context --> pkg_llm
  pkg_time_context --> pkg_session
  pkg_time_context --> pkg_session_projection
  pkg_tmux_context --> pkg_agent
  pkg_tmux_context --> pkg_session
  pkg_tmux_context --> pkg_session_projection
  pkg_tmux_context --> pkg_shell
  pkg_fs_e2b --> pkg_e2b
  pkg_fs_e2b --> pkg_fs
  pkg_commands --> pkg_agent
  pkg_commands --> pkg_attachment
  pkg_commands --> pkg_brand
  pkg_commands --> pkg_invariants
  pkg_commands --> pkg_llm
  pkg_commands --> pkg_scope
  pkg_commands --> pkg_session
  pkg_commands --> pkg_typert_protocol
  pkg_user_approval --> pkg_agent
  pkg_user_approval --> pkg_brand
  pkg_user_approval --> pkg_invariants
  pkg_user_approval --> pkg_llm
  pkg_user_approval --> pkg_scope
  pkg_user_approval --> pkg_session
  pkg_user_approval --> pkg_system_prompt
  pkg_user_questions --> pkg_agent
  pkg_user_questions --> pkg_llm
  pkg_user_questions --> pkg_scope
  pkg_jobs --> pkg_agent
  pkg_jobs --> pkg_brand
  pkg_jobs --> pkg_invariants
  pkg_jobs --> pkg_session
  pkg_lsp_stdio --> pkg_brand
  pkg_lsp_stdio --> pkg_fs
  pkg_lsp_stdio --> pkg_llm
  pkg_lsp_stdio --> pkg_lsp
  pkg_lsp_stdio --> pkg_subprocess
  pkg_lsp_stdio --> pkg_timeout
  pkg_sandbox_policy --> pkg_agent
  pkg_sandbox_policy --> pkg_invariants
  pkg_sandbox_policy --> pkg_sandbox
  pkg_sandbox_policy --> pkg_session
  pkg_sandbox_policy --> pkg_session_projection
  pkg_sandbox_policy --> pkg_system_prompt
  pkg_session_telemetry --> pkg_agent
  pkg_session_telemetry --> pkg_session
  pkg_session_title --> pkg_agent
  pkg_session_title --> pkg_brand
  pkg_session_title --> pkg_invariants
  pkg_session_title --> pkg_llm
  pkg_session_title --> pkg_session
  pkg_session_title --> pkg_session_projection
  pkg_bash_local --> pkg_settings
  pkg_bash_local --> pkg_shell
  pkg_bash_local --> pkg_subprocess
  pkg_bash_local --> pkg_timeout
  pkg_pwsh_local --> pkg_settings
  pkg_pwsh_local --> pkg_shell
  pkg_pwsh_local --> pkg_subprocess
  pkg_pwsh_local --> pkg_timeout
  pkg_terminal --> pkg_agent
  pkg_terminal --> pkg_brand
  pkg_loader_smoke --> pkg_agent
  pkg_loader_smoke --> pkg_http_proxy
  pkg_loader_smoke --> pkg_llm
  pkg_loader_smoke --> pkg_session
  pkg_workflow --> pkg_agent
  pkg_workflow --> pkg_brand
  pkg_workflow --> pkg_invariants
  pkg_workflow --> pkg_llm
  pkg_workflow --> pkg_session
  pkg_tools --> pkg_agent
  pkg_tools --> pkg_code_runtime
  pkg_tools --> pkg_invariants
  pkg_tools --> pkg_llm
  pkg_tools --> pkg_scope
  pkg_tools --> pkg_session
  pkg_tools --> pkg_system_prompt
  pkg_tools --> pkg_user_approval
  pkg_command_goal --> pkg_commands
  pkg_command_goal --> pkg_goal
  pkg_command_goal --> pkg_llm
  pkg_goal_round_driver --> pkg_agent
  pkg_goal_round_driver --> pkg_goal
  pkg_goal_round_driver --> pkg_invariants
  pkg_goal_round_driver --> pkg_llm
  pkg_goal_round_driver --> pkg_session
  pkg_fs_sandbox --> pkg_fs
  pkg_fs_sandbox --> pkg_fs_local
  pkg_fs_sandbox --> pkg_sandbox
  pkg_fs_sandbox --> pkg_sandbox_policy
  pkg_headless --> pkg_agent
  pkg_headless --> pkg_agent_default_model
  pkg_headless --> pkg_llm
  pkg_headless --> pkg_session
  pkg_compaction --> pkg_brand
  pkg_compaction --> pkg_commands
  pkg_compaction --> pkg_invariants
  pkg_compaction --> pkg_llm
  pkg_compaction --> pkg_session
  pkg_command_feedback --> pkg_anonymous_user_id
  pkg_command_feedback --> pkg_commands
  pkg_command_feedback --> pkg_session
  pkg_command_feedback --> pkg_session_telemetry
  pkg_permission_presets --> pkg_commands
  pkg_permission_presets --> pkg_invariants
  pkg_permission_presets --> pkg_sandbox
  pkg_permission_presets --> pkg_sandbox_policy
  pkg_permission_presets --> pkg_session
  pkg_permission_presets --> pkg_session_projection
  pkg_permission_presets --> pkg_settings
  pkg_permission_presets --> pkg_shell
  pkg_permission_presets --> pkg_user_approval
  pkg_jobs_local --> pkg_agent
  pkg_jobs_local --> pkg_jobs
  pkg_jobs_local --> pkg_scope
  pkg_jobs_local --> pkg_timeout
  pkg_session_title_llm --> pkg_llm
  pkg_session_title_llm --> pkg_session
  pkg_session_title_llm --> pkg_session_title
  pkg_session_title_llm --> pkg_timeout
  pkg_bash_sandbox --> pkg_bash_local
  pkg_bash_sandbox --> pkg_sandbox
  pkg_bash_sandbox --> pkg_sandbox_policy
  pkg_bash_sandbox --> pkg_shell
  pkg_pwsh_sandbox --> pkg_pwsh_local
  pkg_pwsh_sandbox --> pkg_sandbox
  pkg_pwsh_sandbox --> pkg_sandbox_policy
  pkg_pwsh_sandbox --> pkg_shell
  pkg_terminal_bash --> pkg_agent
  pkg_terminal_bash --> pkg_sandbox
  pkg_terminal_bash --> pkg_sandbox_policy
  pkg_terminal_bash --> pkg_session
  pkg_terminal_bash --> pkg_session_projection
  pkg_terminal_bash --> pkg_subprocess
  pkg_terminal_bash --> pkg_terminal
  pkg_token_meter --> pkg_compaction
  pkg_token_meter --> pkg_llm
  pkg_token_meter --> pkg_llm_retry
  pkg_token_meter --> pkg_session
  pkg_token_meter --> pkg_session_projection
  pkg_agent_loop --> pkg_agent
  pkg_agent_loop --> pkg_invariants
  pkg_agent_loop --> pkg_llm
  pkg_agent_loop --> pkg_scope
  pkg_agent_loop --> pkg_session
  pkg_agent_loop --> pkg_session_persistence
  pkg_agent_loop --> pkg_session_projection
  pkg_agent_loop --> pkg_settings
  pkg_agent_loop --> pkg_system_prompt
  pkg_agent_loop --> pkg_tools
  pkg_agent_tool_presentation --> pkg_tools
  pkg_tool_goal --> pkg_agent
  pkg_tool_goal --> pkg_goal
  pkg_tool_goal --> pkg_llm
  pkg_tool_goal --> pkg_session
  pkg_tool_goal --> pkg_session_projection
  pkg_tool_goal --> pkg_system_prompt
  pkg_tool_goal --> pkg_tools
  pkg_tool_fs --> pkg_attachment
  pkg_tool_fs --> pkg_fs
  pkg_tool_fs --> pkg_llm
  pkg_tool_fs --> pkg_sandbox
  pkg_tool_fs --> pkg_sandbox_policy
  pkg_tool_fs --> pkg_session
  pkg_tool_fs --> pkg_system_prompt
  pkg_tool_fs --> pkg_tools
  pkg_tool_fs --> pkg_user_approval
  pkg_tool_fs_search --> pkg_llm
  pkg_tool_fs_search --> pkg_output_retention
  pkg_tool_fs_search --> pkg_session
  pkg_tool_fs_search --> pkg_spill
  pkg_tool_fs_search --> pkg_subprocess
  pkg_tool_fs_search --> pkg_system_prompt
  pkg_tool_fs_search --> pkg_timeout
  pkg_tool_fs_search --> pkg_tools
  pkg_tool_str_replace_editor --> pkg_fs
  pkg_tool_str_replace_editor --> pkg_sandbox
  pkg_tool_str_replace_editor --> pkg_sandbox_policy
  pkg_tool_str_replace_editor --> pkg_tools
  pkg_tool_skill --> pkg_agent
  pkg_tool_skill --> pkg_llm
  pkg_tool_skill --> pkg_skill
  pkg_tool_skill --> pkg_tools
  pkg_tool_web --> pkg_llm
  pkg_tool_web --> pkg_system_prompt
  pkg_tool_web --> pkg_tools
  pkg_tool_web --> pkg_web
  pkg_spill_policy --> pkg_llm
  pkg_spill_policy --> pkg_output_retention
  pkg_spill_policy --> pkg_session
  pkg_spill_policy --> pkg_spill
  pkg_spill_policy --> pkg_tools
  pkg_tool_todo --> pkg_agent
  pkg_tool_todo --> pkg_invariants
  pkg_tool_todo --> pkg_session
  pkg_tool_todo --> pkg_session_projection
  pkg_tool_todo --> pkg_tools
  pkg_plan_mode --> pkg_agent
  pkg_plan_mode --> pkg_commands
  pkg_plan_mode --> pkg_invariants
  pkg_plan_mode --> pkg_llm
  pkg_plan_mode --> pkg_session
  pkg_plan_mode --> pkg_session_projection
  pkg_plan_mode --> pkg_system_prompt
  pkg_plan_mode --> pkg_tools
  pkg_plan_mode --> pkg_user_questions
  pkg_hooks_codex --> pkg_agent
  pkg_hooks_codex --> pkg_hook_protocol
  pkg_hooks_codex --> pkg_llm
  pkg_hooks_codex --> pkg_session
  pkg_hooks_codex --> pkg_session_projection
  pkg_hooks_codex --> pkg_tools
  pkg_command_compact --> pkg_commands
  pkg_command_compact --> pkg_compaction
  pkg_agent_instructions --> pkg_agent
  pkg_agent_instructions --> pkg_fs
  pkg_agent_instructions --> pkg_home_paths
  pkg_agent_instructions --> pkg_llm
  pkg_agent_instructions --> pkg_session
  pkg_agent_instructions --> pkg_session_projection
  pkg_agent_instructions --> pkg_tools
  pkg_file_reference_local --> pkg_agent
  pkg_file_reference_local --> pkg_file_reference
  pkg_file_reference_local --> pkg_system_prompt
  pkg_file_reference_local --> pkg_tools
  pkg_cordis_host_runner --> pkg_agent
  pkg_cordis_host_runner --> pkg_brand
  pkg_cordis_host_runner --> pkg_llm
  pkg_cordis_host_runner --> pkg_scope
  pkg_cordis_host_runner --> pkg_session
  pkg_cordis_host_runner --> pkg_tools
  pkg_cordis_host_runner --> pkg_typert_protocol
  pkg_repeat_tool_reminder --> pkg_agent
  pkg_repeat_tool_reminder --> pkg_tools
  pkg_tool_call_timeout_policy --> pkg_llm
  pkg_tool_call_timeout_policy --> pkg_timeout
  pkg_tool_call_timeout_policy --> pkg_tools
  pkg_tool_ask_user --> pkg_agent
  pkg_tool_ask_user --> pkg_tools
  pkg_tool_ask_user --> pkg_user_questions
  pkg_tool_jobs --> pkg_agent
  pkg_tool_jobs --> pkg_jobs
  pkg_tool_jobs --> pkg_llm
  pkg_tool_jobs --> pkg_output_retention
  pkg_tool_jobs --> pkg_system_prompt
  pkg_tool_jobs --> pkg_tools
  pkg_tool_lsp --> pkg_llm
  pkg_tool_lsp --> pkg_lsp
  pkg_tool_lsp --> pkg_system_prompt
  pkg_tool_lsp --> pkg_timeout
  pkg_tool_lsp --> pkg_tools
  pkg_mcp_client --> pkg_attachment
  pkg_mcp_client --> pkg_llm
  pkg_mcp_client --> pkg_scope
  pkg_mcp_client --> pkg_subprocess
  pkg_mcp_client --> pkg_timeout
  pkg_mcp_client --> pkg_tools
  pkg_agent_presets --> pkg_agent
  pkg_agent_presets --> pkg_atomic_write
  pkg_agent_presets --> pkg_home_paths
  pkg_agent_presets --> pkg_invariants
  pkg_agent_presets --> pkg_scope
  pkg_agent_presets --> pkg_session
  pkg_agent_presets --> pkg_session_projection
  pkg_agent_presets --> pkg_settings
  pkg_agent_presets --> pkg_system_prompt
  pkg_agent_presets --> pkg_tools
  pkg_agent_presets --> pkg_typert_protocol
  pkg_schedule --> pkg_agent
  pkg_schedule --> pkg_brand
  pkg_schedule --> pkg_invariants
  pkg_schedule --> pkg_llm
  pkg_schedule --> pkg_session
  pkg_schedule --> pkg_session_persistence
  pkg_schedule --> pkg_session_projection
  pkg_schedule --> pkg_tools
  pkg_session_checkpoint_policy --> pkg_agent
  pkg_session_checkpoint_policy --> pkg_llm
  pkg_session_checkpoint_policy --> pkg_session
  pkg_session_checkpoint_policy --> pkg_session_persistence
  pkg_session_checkpoint_policy --> pkg_tools
  pkg_session_telemetry_otel --> pkg_anonymous_user_id
  pkg_session_telemetry_otel --> pkg_command_feedback
  pkg_session_telemetry_otel --> pkg_llm
  pkg_session_telemetry_otel --> pkg_session
  pkg_session_telemetry_otel --> pkg_session_telemetry
  pkg_session_title_all_prompts_llm --> pkg_llm
  pkg_session_title_all_prompts_llm --> pkg_session
  pkg_session_title_all_prompts_llm --> pkg_session_title
  pkg_session_title_all_prompts_llm --> pkg_session_title_llm
  pkg_session_title_first_prompt_llm --> pkg_llm
  pkg_session_title_first_prompt_llm --> pkg_session
  pkg_session_title_first_prompt_llm --> pkg_session_title
  pkg_session_title_first_prompt_llm --> pkg_session_title_llm
  pkg_shell_env --> pkg_home_paths
  pkg_shell_env --> pkg_shell
  pkg_shell_env --> pkg_tools
  pkg_tool_bash_persistent --> pkg_agent
  pkg_tool_bash_persistent --> pkg_terminal
  pkg_tool_bash_persistent --> pkg_timeout
  pkg_tool_bash_persistent --> pkg_tools
  pkg_tool_pwsh_persistent --> pkg_agent
  pkg_tool_pwsh_persistent --> pkg_terminal
  pkg_tool_pwsh_persistent --> pkg_timeout
  pkg_tool_pwsh_persistent --> pkg_tools
  pkg_tool_terminal --> pkg_agent
  pkg_tool_terminal --> pkg_jobs
  pkg_tool_terminal --> pkg_llm
  pkg_tool_terminal --> pkg_output_retention
  pkg_tool_terminal --> pkg_system_prompt
  pkg_tool_terminal --> pkg_terminal
  pkg_tool_terminal --> pkg_tools
  pkg_agent_loop_testkit --> pkg_agent
  pkg_agent_loop_testkit --> pkg_llm
  pkg_agent_loop_testkit --> pkg_session
  pkg_agent_loop_testkit --> pkg_system_prompt
  pkg_agent_loop_testkit --> pkg_tools
  pkg_llm_replay --> pkg_compaction
  pkg_llm_replay --> pkg_deepseek_llm_api_extensions
  pkg_llm_replay --> pkg_llm
  pkg_llm_replay --> pkg_session
  pkg_tool_workflow --> pkg_agent
  pkg_tool_workflow --> pkg_invariants
  pkg_tool_workflow --> pkg_llm
  pkg_tool_workflow --> pkg_session
  pkg_tool_workflow --> pkg_system_prompt
  pkg_tool_workflow --> pkg_tools
  pkg_tool_workflow --> pkg_workflow
  pkg_plugin_package_inventory_deepseek --> pkg_agent
  pkg_plugin_package_inventory_deepseek --> pkg_agent_presets
  pkg_plugin_package_inventory_deepseek --> pkg_deepseek_llm_api_extensions
  pkg_plugin_package_inventory_deepseek --> pkg_session
  pkg_session_query --> pkg_brand
  pkg_session_query --> pkg_llm
  pkg_session_query --> pkg_session
  pkg_session_query --> pkg_session_persistence
  pkg_session_query --> pkg_session_projection
  pkg_session_query --> pkg_session_projection_cache
  pkg_session_query --> pkg_session_title
  pkg_session_query --> pkg_tool_todo
  pkg_acp --> pkg_agent
  pkg_acp --> pkg_attachment
  pkg_acp --> pkg_llm
  pkg_acp --> pkg_mcp_client
  pkg_acp --> pkg_session
  pkg_acp --> pkg_session_persistence
  pkg_acp --> pkg_token_meter
  pkg_acp --> pkg_user_approval
  pkg_api_settings_controller --> pkg_agent_presets
  pkg_api_settings_controller --> pkg_credentials
  pkg_api_settings_controller --> pkg_native_command
  pkg_api_settings_controller --> pkg_session
  pkg_api_settings_controller --> pkg_settings
  pkg_api_settings_controller --> pkg_typert_protocol
  pkg_web_app --> pkg_shell_env
  pkg_web_app --> pkg_system_prompt
  pkg_compaction_tool_result_pruner --> pkg_compaction
  pkg_compaction_tool_result_pruner --> pkg_llm
  pkg_compaction_tool_result_pruner --> pkg_session
  pkg_compaction_tool_result_pruner --> pkg_token_meter
  pkg_tool_cordis --> pkg_agent
  pkg_tool_cordis --> pkg_cordis_host_runner
  pkg_tool_cordis --> pkg_llm
  pkg_tool_cordis --> pkg_scope
  pkg_tool_cordis --> pkg_session
  pkg_tool_cordis --> pkg_system_prompt
  pkg_tool_cordis --> pkg_tools
  pkg_host_plugin_inventory --> pkg_agent_presets
  pkg_host_plugin_inventory --> pkg_brand
  pkg_host_plugin_inventory --> pkg_typert_protocol
  pkg_mcp_manager --> pkg_credentials
  pkg_mcp_manager --> pkg_invariants
  pkg_mcp_manager --> pkg_mcp_client
  pkg_mcp_manager --> pkg_settings
  pkg_mcp_manager --> pkg_tools
  pkg_mcp_manager --> pkg_util_values
  pkg_tool_bash --> pkg_agent
  pkg_tool_bash --> pkg_jobs
  pkg_tool_bash --> pkg_llm
  pkg_tool_bash --> pkg_sandbox
  pkg_tool_bash --> pkg_sandbox_policy
  pkg_tool_bash --> pkg_shell
  pkg_tool_bash --> pkg_shell_env
  pkg_tool_bash --> pkg_system_prompt
  pkg_tool_bash --> pkg_tools
  pkg_tool_bash --> pkg_user_approval
  pkg_tool_pwsh --> pkg_agent
  pkg_tool_pwsh --> pkg_jobs
  pkg_tool_pwsh --> pkg_llm
  pkg_tool_pwsh --> pkg_sandbox
  pkg_tool_pwsh --> pkg_sandbox_policy
  pkg_tool_pwsh --> pkg_shell
  pkg_tool_pwsh --> pkg_shell_env
  pkg_tool_pwsh --> pkg_system_prompt
  pkg_tool_pwsh --> pkg_tools
  pkg_tool_pwsh --> pkg_user_approval
  pkg_webhook --> pkg_agent
  pkg_webhook --> pkg_agent_default_model
  pkg_webhook --> pkg_agent_presets
  pkg_webhook --> pkg_invariants
  pkg_webhook --> pkg_llm
  pkg_webhook --> pkg_permission_presets
  pkg_webhook --> pkg_session
  pkg_webhook --> pkg_session_title
  pkg_webhook --> pkg_workspace
  pkg_subagent --> pkg_agent
  pkg_subagent --> pkg_agent_presets
  pkg_subagent --> pkg_attachment
  pkg_subagent --> pkg_invariants
  pkg_subagent --> pkg_jobs
  pkg_subagent --> pkg_llm
  pkg_subagent --> pkg_sandbox
  pkg_subagent --> pkg_sandbox_policy
  pkg_subagent --> pkg_scope
  pkg_subagent --> pkg_session
  pkg_subagent --> pkg_session_persistence
  pkg_subagent --> pkg_session_projection
  pkg_subagent --> pkg_session_projection_cache
  pkg_subagent --> pkg_session_query
  pkg_subagent --> pkg_system_prompt
  pkg_subagent --> pkg_tools
  pkg_subagent --> pkg_typert_protocol
  pkg_subagent --> pkg_user_approval
  pkg_subagent --> pkg_util_time
  pkg_session_query_sqlite --> pkg_session
  pkg_session_query_sqlite --> pkg_session_persistence
  pkg_session_query_sqlite --> pkg_session_query
  pkg_tool_session_query --> pkg_agent
  pkg_tool_session_query --> pkg_llm
  pkg_tool_session_query --> pkg_session
  pkg_tool_session_query --> pkg_session_projection
  pkg_tool_session_query --> pkg_session_query
  pkg_tool_session_query --> pkg_system_prompt
  pkg_tool_session_query --> pkg_timeout
  pkg_tool_session_query --> pkg_tools
  pkg_compaction_basic --> pkg_agent
  pkg_compaction_basic --> pkg_commands
  pkg_compaction_basic --> pkg_compaction
  pkg_compaction_basic --> pkg_compaction_tool_result_pruner
  pkg_compaction_basic --> pkg_llm
  pkg_compaction_basic --> pkg_session
  pkg_compaction_basic --> pkg_token_meter
  pkg_session_reference --> pkg_agent
  pkg_session_reference --> pkg_compaction
  pkg_session_reference --> pkg_llm
  pkg_session_reference --> pkg_output_retention
  pkg_session_reference --> pkg_session
  pkg_session_reference --> pkg_session_projection
  pkg_session_reference --> pkg_session_projection_cache
  pkg_session_reference --> pkg_session_query
  pkg_session_reference --> pkg_session_title
  pkg_session_reference --> pkg_typert_protocol
  pkg_webhook_github --> pkg_credentials
  pkg_webhook_github --> pkg_host_webserver
  pkg_webhook_github --> pkg_session
  pkg_webhook_github --> pkg_webhook
  pkg_subagent_acp --> pkg_agent
  pkg_subagent_acp --> pkg_llm
  pkg_subagent_acp --> pkg_session
  pkg_subagent_acp --> pkg_subagent
  pkg_subagent_acp --> pkg_subprocess
  pkg_subagent_acp --> pkg_timeout
  pkg_subagent_claude_code --> pkg_llm
  pkg_subagent_claude_code --> pkg_session
  pkg_subagent_claude_code --> pkg_subagent
  pkg_subagent_claude_code --> pkg_subprocess
  pkg_subagent_claude_code --> pkg_timeout
  pkg_subagent_codex --> pkg_llm
  pkg_subagent_codex --> pkg_session
  pkg_subagent_codex --> pkg_subagent
  pkg_subagent_codex --> pkg_subprocess
  pkg_subagent_codex --> pkg_timeout
  pkg_subagent_in_process_driver --> pkg_agent
  pkg_subagent_in_process_driver --> pkg_llm
  pkg_subagent_in_process_driver --> pkg_session
  pkg_subagent_in_process_driver --> pkg_subagent
  pkg_subagent_in_process_driver --> pkg_system_prompt
  pkg_subagent_in_process_driver --> pkg_tools
  pkg_tool_subagent --> pkg_agent
  pkg_tool_subagent --> pkg_invariants
  pkg_tool_subagent --> pkg_jobs
  pkg_tool_subagent --> pkg_llm
  pkg_tool_subagent --> pkg_scope
  pkg_tool_subagent --> pkg_session
  pkg_tool_subagent --> pkg_session_projection
  pkg_tool_subagent --> pkg_settings
  pkg_tool_subagent --> pkg_subagent
  pkg_tool_subagent --> pkg_system_prompt
  pkg_tool_subagent --> pkg_tools
  pkg_tool_subagent_control --> pkg_llm
  pkg_tool_subagent_control --> pkg_session
  pkg_tool_subagent_control --> pkg_subagent
  pkg_tool_subagent_control --> pkg_tools
  pkg_hooks_claude_code --> pkg_agent
  pkg_hooks_claude_code --> pkg_hook_protocol
  pkg_hooks_claude_code --> pkg_llm
  pkg_hooks_claude_code --> pkg_session
  pkg_hooks_claude_code --> pkg_session_projection
  pkg_hooks_claude_code --> pkg_subagent
  pkg_hooks_claude_code --> pkg_tools
  pkg_api_session_controller --> pkg_agent
  pkg_api_session_controller --> pkg_agent_default_model
  pkg_api_session_controller --> pkg_agent_presets
  pkg_api_session_controller --> pkg_api_gateway
  pkg_api_session_controller --> pkg_attachment
  pkg_api_session_controller --> pkg_client_connection
  pkg_api_session_controller --> pkg_client_file_upload
  pkg_api_session_controller --> pkg_commands
  pkg_api_session_controller --> pkg_file_reference
  pkg_api_session_controller --> pkg_jobs
  pkg_api_session_controller --> pkg_llm
  pkg_api_session_controller --> pkg_native_command
  pkg_api_session_controller --> pkg_scope
  pkg_api_session_controller --> pkg_session
  pkg_api_session_controller --> pkg_session_persistence
  pkg_api_session_controller --> pkg_session_projection
  pkg_api_session_controller --> pkg_session_projection_cache
  pkg_api_session_controller --> pkg_session_query
  pkg_api_session_controller --> pkg_session_title
  pkg_api_session_controller --> pkg_skill
  pkg_api_session_controller --> pkg_subagent
  pkg_api_session_controller --> pkg_typert_protocol
  pkg_api_session_controller --> pkg_typert_registry
  pkg_api_session_controller --> pkg_util_time
  pkg_api_session_controller --> pkg_util_workspace_path
  pkg_api_session_controller --> pkg_workspace
  pkg_experimental_agent_team --> pkg_agent
  pkg_experimental_agent_team --> pkg_invariants
  pkg_experimental_agent_team --> pkg_llm
  pkg_experimental_agent_team --> pkg_session
  pkg_experimental_agent_team --> pkg_session_persistence
  pkg_experimental_agent_team --> pkg_session_projection
  pkg_experimental_agent_team --> pkg_subagent
  pkg_experimental_agent_team --> pkg_typert_protocol
  pkg_sdk_protocol --> pkg_llm
  pkg_sdk_protocol --> pkg_session
  pkg_sdk_protocol --> pkg_subagent
  pkg_tool_ralph --> pkg_agent
  pkg_tool_ralph --> pkg_llm
  pkg_tool_ralph --> pkg_subagent
  pkg_tool_ralph --> pkg_system_prompt
  pkg_tool_ralph --> pkg_tools
  pkg_tool_ralph --> pkg_workflow
  pkg_workflow_worker_thread --> pkg_agent
  pkg_workflow_worker_thread --> pkg_llm
  pkg_workflow_worker_thread --> pkg_session
  pkg_workflow_worker_thread --> pkg_subagent
  pkg_workflow_worker_thread --> pkg_tools
  pkg_workflow_worker_thread --> pkg_workflow
  pkg_subagent_fork_in_process --> pkg_agent
  pkg_subagent_fork_in_process --> pkg_session
  pkg_subagent_fork_in_process --> pkg_subagent
  pkg_subagent_fork_in_process --> pkg_subagent_in_process_driver
  pkg_subagent_spawn_in_process --> pkg_subagent
  pkg_subagent_spawn_in_process --> pkg_subagent_in_process_driver
  pkg_experimental_client_ui_agent_team --> pkg_api_remotes
  pkg_experimental_client_ui_agent_team --> pkg_api_session_controller
  pkg_experimental_client_ui_agent_team --> pkg_client_locale
  pkg_experimental_client_ui_agent_team --> pkg_client_ui_conversation
  pkg_experimental_client_ui_agent_team --> pkg_client_ui_primitives
  pkg_experimental_client_ui_agent_team --> pkg_client_ui_renderer
  pkg_experimental_client_ui_agent_team --> pkg_client_ui_session
  pkg_experimental_client_ui_agent_team --> pkg_client_ui_slots
  pkg_experimental_client_ui_agent_team --> pkg_experimental_agent_team
  pkg_experimental_client_ui_agent_team --> pkg_session
  pkg_experimental_client_ui_agent_team --> pkg_typert_protocol
  pkg_experimental_tool_agent_team --> pkg_agent
  pkg_experimental_tool_agent_team --> pkg_experimental_agent_team
  pkg_experimental_tool_agent_team --> pkg_session
  pkg_experimental_tool_agent_team --> pkg_system_prompt
  pkg_experimental_tool_agent_team --> pkg_tools
  pkg_sdk_client --> pkg_llm
  pkg_sdk_client --> pkg_sdk_protocol
  pkg_sdk_client --> pkg_session
  pkg_sdk_jsonrpc_server --> pkg_agent
  pkg_sdk_jsonrpc_server --> pkg_attachment
  pkg_sdk_jsonrpc_server --> pkg_llm
  pkg_sdk_jsonrpc_server --> pkg_llm_deepseek
  pkg_sdk_jsonrpc_server --> pkg_scope
  pkg_sdk_jsonrpc_server --> pkg_sdk_protocol
  pkg_sdk_jsonrpc_server --> pkg_session
  pkg_sdk_jsonrpc_server --> pkg_subagent
  pkg_client_test_runtime --> pkg_api_session_controller
  pkg_client_test_runtime --> pkg_api_workspace_controller
  pkg_client_test_runtime --> pkg_attachment
  pkg_client_test_runtime --> pkg_client_connection
  pkg_client_test_runtime --> pkg_client_store
  pkg_client_test_runtime --> pkg_client_ui_chat
  pkg_client_test_runtime --> pkg_client_ui_conversation
  pkg_client_test_runtime --> pkg_client_ui_renderer
  pkg_client_test_runtime --> pkg_client_ui_session
  pkg_client_test_runtime --> pkg_client_ui_settings
  pkg_client_test_runtime --> pkg_client_ui_slots
  pkg_client_test_runtime --> pkg_session
  pkg_client_test_runtime --> pkg_subagent
  pkg_client_test_runtime --> pkg_typert_protocol
  pkg_subagent_dsh_sdk --> pkg_agent
  pkg_subagent_dsh_sdk --> pkg_llm
  pkg_subagent_dsh_sdk --> pkg_sdk_client
  pkg_subagent_dsh_sdk --> pkg_session
  pkg_subagent_dsh_sdk --> pkg_subagent
  pkg_subagent_dsh_sdk --> pkg_subprocess
```

| 包 | 分组 | Peer 依赖 |
| --- | --- | --- |
| [`atomic-write`](../packages/util/atomic-write) | `util` | — |
| [`brand`](../packages/util/brand) | `util` | — |
| [`deque`](../packages/util/deque) | `util` | — |
| [`home-paths`](../packages/util/home-paths) | `util` | — |
| [`http-proxy`](../packages/util/http-proxy) | `util` | — |
| [`launch-environment`](../packages/util/launch-environment) | `util` | — |
| [`native-command`](../packages/util/native-command) | `util` | — |
| [`output-retention`](../packages/util/output-retention) | `util` | — |
| [`timeout`](../packages/util/timeout) | `util` | — |
| [`util-crypto`](../packages/util/crypto) | `util` | — |
| [`util-time`](../packages/util/time) | `util` | — |
| [`util-values`](../packages/util/values) | `util` | — |
| [`util-workspace-path`](../packages/util/workspace-path) | `util` | — |
| [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions) | `llm` | — |
| [`llm`](../packages/llm/llm) | `llm` | — |
| [`api-gateway`](../packages/api/gateway) | `api` | — |
| [`cmdline`](../packages/boot/cmdline) | `boot` | — |
| [`acp-app`](../packages/bundle/acp-app) | `bundle` | — |
| [`base`](../packages/bundle/base) | `bundle` | — |
| [`sdk-app`](../packages/bundle/sdk-app) | `bundle` | — |
| [`sdk-minimal`](../packages/bundle/sdk-minimal) | `bundle` | — |
| [`client-connection`](../packages/client/connection) | `client` | — |
| [`client-hmr`](../packages/client/hmr) | `client` | — |
| [`client-locale`](../packages/client/locale) | `client` | — |
| [`client-modules`](../packages/client/modules) | `client` | — |
| [`client-store`](../packages/client/store) | `client` | — |
| [`client-ui-agent-preset`](../packages/client/ui-agent-preset) | `client` | — |
| [`client-ui-approval`](../packages/client/ui-approval) | `client` | — |
| [`client-ui-attachment`](../packages/client/ui-attachment) | `client` | — |
| [`client-ui-brand-official`](../packages/client/ui-brand-official) | `client` | — |
| [`client-ui-chat`](../packages/client/ui-chat) | `client` | — |
| [`client-ui-commands`](../packages/client/ui-commands) | `client` | — |
| [`client-ui-conversation`](../packages/client/ui-conversation) | `client` | — |
| [`client-ui-deliverables`](../packages/client/ui-deliverables) | `client` | — |
| [`client-ui-directory-picker-browse`](../packages/client/ui-directory-picker-browse) | `client` | — |
| [`client-ui-directory-picker-native`](../packages/client/ui-directory-picker-native) | `client` | — |
| [`client-ui-goal`](../packages/client/ui-goal) | `client` | — |
| [`client-ui-input-trigger`](../packages/client/ui-input-trigger) | `client` | — |
| [`client-ui-jobs`](../packages/client/ui-jobs) | `client` | — |
| [`client-ui-layout`](../packages/client/ui-layout) | `client` | — |
| [`client-ui-message-feedback`](../packages/client/ui-message-feedback) | `client` | — |
| [`client-ui-model-selection`](../packages/client/ui-model-selection) | `client` | — |
| [`client-ui-permission-presets`](../packages/client/ui-permission-presets) | `client` | — |
| [`client-ui-plan`](../packages/client/ui-plan) | `client` | — |
| [`client-ui-primitives`](../packages/client/ui-primitives) | `client` | — |
| [`client-ui-reference`](../packages/client/ui-reference) | `client` | — |
| [`client-ui-renderer`](../packages/client/ui-renderer) | `client` | — |
| [`client-ui-schedule`](../packages/client/ui-schedule) | `client` | — |
| [`client-ui-session`](../packages/client/ui-session) | `client` | — |
| [`client-ui-settings`](../packages/client/ui-settings) | `client` | — |
| [`client-ui-settings-general`](../packages/client/ui-settings-general) | `client` | — |
| [`client-ui-settings-models`](../packages/client/ui-settings-models) | `client` | — |
| [`client-ui-settings-plugin-inventory`](../packages/client/ui-settings-plugin-inventory) | `client` | — |
| [`client-ui-settings-plugins`](../packages/client/ui-settings-plugins) | `client` | — |
| [`client-ui-sidebar`](../packages/client/ui-sidebar) | `client` | — |
| [`client-ui-skill`](../packages/client/ui-skill) | `client` | — |
| [`client-ui-slots`](../packages/client/ui-slots) | `client` | — |
| [`client-ui-subagent`](../packages/client/ui-subagent) | `client` | — |
| [`client-ui-theme`](../packages/client/ui-theme) | `client` | — |
| [`client-ui-tool`](../packages/client/ui-tool) | `client` | — |
| [`client-ui-trajectory`](../packages/client/ui-trajectory) | `client` | — |
| [`client-ui-user-questions`](../packages/client/ui-user-questions) | `client` | — |
| [`client-ui-workflow-run`](../packages/client/ui-workflow-run) | `client` | — |
| [`client-ui-workspace`](../packages/client/ui-workspace) | `client` | — |
| [`client-web`](../packages/client/web) | `client` | — |
| [`code-runtime`](../packages/code-runtime/code-runtime) | `code-runtime` | — |
| [`experimental-agent-team-profile`](../packages/experimental/agent-team-profile) | `experimental` | — |
| [`experimental-agent-team-web-profile`](../packages/experimental/agent-team-web-profile) | `experimental` | — |
| [`experimental-webworker-packer`](../packages/experimental/webworker-packer) | `experimental` | — |
| [`client-ui-cordis`](../packages/extensions/ui-cordis) | `extensions` | — |
| [`cordis-client-runner`](../packages/extensions/cordis-client-runner) | `extensions` | — |
| [`host-directory-picker`](../packages/host/directory-picker) | `host` | — |
| [`host-directory-picker-browse`](../packages/host/directory-picker-browse) | `host` | — |
| [`host-directory-picker-native`](../packages/host/directory-picker-native) | `host` | — |
| [`host-webserver`](../packages/host/webserver) | `host` | — |
| [`invariants`](../packages/runtime-diagnostics/invariants) | `runtime-diagnostics` | — |
| [`sandbox-windows-acl`](../packages/sandbox/sandbox-windows-acl) | `sandbox` | — |
| [`session-format`](../packages/session/session-format) | `session` | — |
| [`session-format-v0-to-v1`](../packages/session/session-format-v0-to-v1) | `session` | — |
| [`session-format-v1-to-v2`](../packages/session/session-format-v1-to-v2) | `session` | — |
| [`storage`](../packages/storage/storage) | `storage` | — |
| [`win32-process`](../packages/subprocess/win32-process) | `subprocess` | — |
| [`llm-mock-server`](../packages/test-support/llm-mock-server) | `test-support` | — |
| [`typert-generator`](../packages/typert/generator) | `typert` | — |
| [`typert-protocol`](../packages/typert/protocol) | `typert` | — |
| [`typert-registry`](../packages/typert/registry) | `typert` | — |
| [`scope`](../packages/core/scope) | `core` | [`invariants`](../packages/runtime-diagnostics/invariants) |
| [`web`](../packages/web/web) | `web` | [`llm`](../packages/llm/llm) |
| [`attachment`](../packages/attachment/attachment) | `attachment` | [`brand`](../packages/util/brand) |
| [`credentials`](../packages/credentials/credentials) | `credentials` | [`invariants`](../packages/runtime-diagnostics/invariants) |
| [`e2b`](../packages/e2b/e2b) | `e2b` | [`http-proxy`](../packages/util/http-proxy) |
| [`experimental-code-runtime-python`](../packages/experimental/code-runtime-python) | `experimental` | [`code-runtime`](../packages/code-runtime/code-runtime), [`timeout`](../packages/util/timeout), [`util-values`](../packages/util/values) |
| [`experimental-inspector`](../packages/experimental/inspector) | `experimental` | [`client-modules`](../packages/client/modules), [`host-webserver`](../packages/host/webserver) |
| [`experimental-webworker-runtime`](../packages/experimental/webworker-runtime) | `experimental` | [`client-connection`](../packages/client/connection), [`client-modules`](../packages/client/modules), [`host-webserver`](../packages/host/webserver) |
| [`host-directory-picker-auto`](../packages/host/directory-picker-auto) | `host` | [`client-ui-directory-picker-browse`](../packages/client/ui-directory-picker-browse), [`client-ui-directory-picker-native`](../packages/client/ui-directory-picker-native), [`host-directory-picker-browse`](../packages/host/directory-picker-browse), [`host-directory-picker-native`](../packages/host/directory-picker-native), [`host-webserver`](../packages/host/webserver) |
| [`host-frontend-static`](../packages/host/frontend-static) | `host` | [`client-connection`](../packages/client/connection), [`host-webserver`](../packages/host/webserver) |
| [`anonymous-user-id`](../packages/identity/anonymous-user-id) | `identity` | [`brand`](../packages/util/brand), [`home-paths`](../packages/util/home-paths) |
| [`lsp`](../packages/lsp/lsp) | `lsp` | [`brand`](../packages/util/brand), [`llm`](../packages/llm/llm) |
| [`storage-domain`](../packages/storage/storage-domain) | `storage` | [`invariants`](../packages/runtime-diagnostics/invariants), [`storage`](../packages/storage/storage) |
| [`storage-json`](../packages/storage/storage-json) | `storage` | [`storage`](../packages/storage/storage) |
| [`storage-sqlite`](../packages/storage/storage-sqlite) | `storage` | [`storage`](../packages/storage/storage) |
| [`subprocess`](../packages/subprocess/subprocess) | `subprocess` | [`http-proxy`](../packages/util/http-proxy) |
| [`typert-loader`](../packages/typert/loader) | `typert` | [`typert-registry`](../packages/typert/registry) |
| [`session`](../packages/core/session) | `core` | [`scope`](../packages/core/scope) |
| [`system-prompt`](../packages/core/system-prompt) | `core` | [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope) |
| [`skill`](../packages/skill/skill) | `skill` | [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope) |
| [`web-fetch-http`](../packages/web/web-fetch-http) | `web` | [`http-proxy`](../packages/util/http-proxy), [`timeout`](../packages/util/timeout), [`web`](../packages/web/web) |
| [`web-search-exa`](../packages/web/web-search-exa) | `web` | [`launch-environment`](../packages/util/launch-environment), [`web`](../packages/web/web) |
| [`web-search-perplexity`](../packages/web/web-search-perplexity) | `web` | [`launch-environment`](../packages/util/launch-environment), [`web`](../packages/web/web) |
| [`api-remotes`](../packages/api/remotes) | `api` | [`scope`](../packages/core/scope) |
| [`attachment-local`](../packages/attachment/attachment-local) | `attachment` | [`attachment`](../packages/attachment/attachment), [`home-paths`](../packages/util/home-paths) |
| [`client-file-upload`](../packages/client/file-upload) | `client` | [`scope`](../packages/core/scope) |
| [`authorization`](../packages/credentials/authorization) | `credentials` | [`credentials`](../packages/credentials/credentials), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm) |
| [`credentials-local`](../packages/credentials/credentials-local) | `credentials` | [`atomic-write`](../packages/util/atomic-write), [`credentials`](../packages/credentials/credentials), [`home-paths`](../packages/util/home-paths), [`launch-environment`](../packages/util/launch-environment) |
| [`subprocess-e2b`](../packages/e2b/subprocess-e2b) | `e2b` | [`e2b`](../packages/e2b/e2b), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subprocess-local`](../packages/subprocess/subprocess-local) | `subprocess` | [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`skill-badge`](../packages/skill/skill-badge) | `skill` | [`skill`](../packages/skill/skill) |
| [`spill`](../packages/spill/spill) | `spill` | [`brand`](../packages/util/brand), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`app-boot`](../packages/boot/app-boot) | `boot` | [`home-paths`](../packages/util/home-paths), [`launch-environment`](../packages/util/launch-environment), [`system-prompt`](../packages/core/system-prompt) |
| [`code-runtime-worker-thread`](../packages/code-runtime/code-runtime-worker-thread) | `code-runtime` | [`code-runtime`](../packages/code-runtime/code-runtime), [`session`](../packages/core/session), [`timeout`](../packages/util/timeout) |
| [`persona`](../packages/preset/persona) | `preset` | [`system-prompt`](../packages/core/system-prompt) |
| [`sandbox`](../packages/sandbox/sandbox) | `sandbox` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`session-format-catalog`](../packages/session/session-format-catalog) | `session` | [`session`](../packages/core/session) |
| [`session-log-deepseek`](../packages/session/session-log-deepseek) | `session` | [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions), [`invariants`](../packages/runtime-diagnostics/invariants), [`session`](../packages/core/session) |
| [`session-persistence`](../packages/session/session-persistence) | `session` | [`brand`](../packages/util/brand), [`session`](../packages/core/session), [`timeout`](../packages/util/timeout) |
| [`session-projection`](../packages/session/session-projection) | `session` | [`session`](../packages/core/session) |
| [`settings`](../packages/settings/settings) | `settings` | [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`session`](../packages/core/session) |
| [`session-snapshot`](../packages/test-support/session-snapshot) | `test-support` | [`http-proxy`](../packages/util/http-proxy), [`session`](../packages/core/session) |
| [`agent`](../packages/core/agent) | `core` | [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`system-prompt`](../packages/core/system-prompt), [`typert-protocol`](../packages/typert/protocol) |
| [`fs`](../packages/fs/fs) | `fs` | [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox) |
| [`spill-local`](../packages/spill/spill-local) | `spill` | [`spill`](../packages/spill/spill) |
| [`session-log-export`](../packages/session-query/session-log-export) | `session-query` | [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence) |
| [`message-feedback`](../packages/feedback/message-feedback) | `feedback` | [`brand`](../packages/util/brand), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`storage-domain`](../packages/storage/storage-domain), [`typert-protocol`](../packages/typert/protocol) |
| [`sandbox-local`](../packages/sandbox/sandbox-local) | `sandbox` | [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`session`](../packages/core/session) |
| [`session-persistence-jsonl`](../packages/session/session-persistence-jsonl) | `session` | [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence) |
| [`session-projection-cache`](../packages/session/session-projection-cache) | `session` | [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`storage-domain`](../packages/storage/storage-domain) |
| [`session-stats`](../packages/session/session-stats) | `session` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection) |
| [`session-turn-outline`](../packages/session/session-turn-outline) | `session` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection) |
| [`settings-file`](../packages/settings/settings-file) | `settings` | [`atomic-write`](../packages/util/atomic-write), [`home-paths`](../packages/util/home-paths), [`settings`](../packages/settings/settings) |
| [`shell`](../packages/shell/shell) | `shell` | [`sandbox`](../packages/sandbox/sandbox), [`settings`](../packages/settings/settings), [`subprocess`](../packages/subprocess/subprocess) |
| [`workspace`](../packages/workspace/workspace) | `workspace` | [`invariants`](../packages/runtime-diagnostics/invariants), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`storage`](../packages/storage/storage), [`storage-domain`](../packages/storage/storage-domain), [`typert-protocol`](../packages/typert/protocol) |
| [`llm-deepseek`](../packages/llm/llm-deepseek) | `llm` | [`anonymous-user-id`](../packages/identity/anonymous-user-id), [`atomic-write`](../packages/util/atomic-write), [`attachment`](../packages/attachment/attachment), [`credentials`](../packages/credentials/credentials), [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions), [`fs`](../packages/fs/fs), [`home-paths`](../packages/util/home-paths), [`launch-environment`](../packages/util/launch-environment), [`llm`](../packages/llm/llm), [`settings`](../packages/settings/settings), [`timeout`](../packages/util/timeout) |
| [`llm-pi-ai`](../packages/llm/llm-pi-ai) | `llm` | [`attachment`](../packages/attachment/attachment), [`authorization`](../packages/credentials/authorization), [`credentials`](../packages/credentials/credentials), [`fs`](../packages/fs/fs), [`launch-environment`](../packages/util/launch-environment), [`llm`](../packages/llm/llm), [`settings`](../packages/settings/settings), [`timeout`](../packages/util/timeout) |
| [`llm-retry`](../packages/llm/llm-retry) | `llm` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`timeout`](../packages/util/timeout) |
| [`agent-default-model`](../packages/core/agent-default-model) | `core` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`settings`](../packages/settings/settings) |
| [`goal`](../packages/goal/goal) | `goal` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`typert-protocol`](../packages/typert/protocol) |
| [`fs-local`](../packages/fs/fs-local) | `fs` | [`fs`](../packages/fs/fs) |
| [`fs-observation-policy`](../packages/fs/fs-observation-policy) | `fs` | [`fs`](../packages/fs/fs) |
| [`skill-filesystem`](../packages/skill/skill-filesystem) | `skill` | [`fs`](../packages/fs/fs), [`home-paths`](../packages/util/home-paths), [`skill`](../packages/skill/skill) |
| [`web-search-deepseek`](../packages/web/web-search-deepseek) | `web` | [`agent`](../packages/core/agent), [`credentials`](../packages/credentials/credentials), [`launch-environment`](../packages/util/launch-environment), [`session`](../packages/core/session), [`settings`](../packages/settings/settings), [`web`](../packages/web/web) |
| [`hook-protocol`](../packages/hooks/hook-protocol) | `hooks` | [`invariants`](../packages/runtime-diagnostics/invariants), [`session`](../packages/core/session), [`shell`](../packages/shell/shell) |
| [`api-workspace-controller`](../packages/api/workspace-controller) | `api` | [`api-gateway`](../packages/api/gateway), [`client-connection`](../packages/client/connection), [`host-directory-picker`](../packages/host/directory-picker), [`session`](../packages/core/session), [`storage-domain`](../packages/storage/storage-domain), [`typert-protocol`](../packages/typert/protocol), [`workspace`](../packages/workspace/workspace) |
| [`file-reference`](../packages/context/file-reference) | `context` | [`agent`](../packages/core/agent) |
| [`time-context`](../packages/context/time-context) | `context` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection) |
| [`tmux-context`](../packages/context/tmux-context) | `context` | [`agent`](../packages/core/agent), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`shell`](../packages/shell/shell) |
| [`fs-e2b`](../packages/e2b/fs-e2b) | `e2b` | [`e2b`](../packages/e2b/e2b), [`fs`](../packages/fs/fs) |
| [`commands`](../packages/interaction/commands) | `interaction` | [`agent`](../packages/core/agent), [`attachment`](../packages/attachment/attachment), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`typert-protocol`](../packages/typert/protocol) |
| [`user-approval`](../packages/interaction/user-approval) | `interaction` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt) |
| [`user-questions`](../packages/interaction/user-questions) | `interaction` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope) |
| [`jobs`](../packages/jobs/jobs) | `jobs` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`session`](../packages/core/session) |
| [`lsp-stdio`](../packages/lsp/lsp-stdio) | `lsp` | [`brand`](../packages/util/brand), [`fs`](../packages/fs/fs), [`llm`](../packages/llm/llm), [`lsp`](../packages/lsp/lsp), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`sandbox-policy`](../packages/sandbox/sandbox-policy) | `sandbox` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`sandbox`](../packages/sandbox/sandbox), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`system-prompt`](../packages/core/system-prompt) |
| [`session-telemetry`](../packages/session/session-telemetry) | `session` | [`agent`](../packages/core/agent), [`session`](../packages/core/session) |
| [`session-title`](../packages/session/session-title) | `session` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection) |
| [`bash-local`](../packages/shell/bash-local) | `shell` | [`settings`](../packages/settings/settings), [`shell`](../packages/shell/shell), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`pwsh-local`](../packages/shell/pwsh-local) | `shell` | [`settings`](../packages/settings/settings), [`shell`](../packages/shell/shell), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`terminal`](../packages/terminal/terminal) | `terminal` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand) |
| [`loader-smoke`](../packages/test-support/loader-smoke) | `test-support` | [`agent`](../packages/core/agent), [`http-proxy`](../packages/util/http-proxy), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`workflow`](../packages/workflow/workflow) | `workflow` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`tools`](../packages/core/tools) | `core` | [`agent`](../packages/core/agent), [`code-runtime`](../packages/code-runtime/code-runtime), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`user-approval`](../packages/interaction/user-approval) |
| [`command-goal`](../packages/goal/command-goal) | `goal` | [`commands`](../packages/interaction/commands), [`goal`](../packages/goal/goal), [`llm`](../packages/llm/llm) |
| [`goal-round-driver`](../packages/goal/goal-round-driver) | `goal` | [`agent`](../packages/core/agent), [`goal`](../packages/goal/goal), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`fs-sandbox`](../packages/fs/fs-sandbox) | `fs` | [`fs`](../packages/fs/fs), [`fs-local`](../packages/fs/fs-local), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy) |
| [`headless`](../packages/bundle/headless) | `bundle` | [`agent`](../packages/core/agent), [`agent-default-model`](../packages/core/agent-default-model), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`compaction`](../packages/compaction/compaction) | `compaction` | [`brand`](../packages/util/brand), [`commands`](../packages/interaction/commands), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`command-feedback`](../packages/feedback/command-feedback) | `feedback` | [`anonymous-user-id`](../packages/identity/anonymous-user-id), [`commands`](../packages/interaction/commands), [`session`](../packages/core/session), [`session-telemetry`](../packages/session/session-telemetry) |
| [`permission-presets`](../packages/interaction/permission-presets) | `interaction` | [`commands`](../packages/interaction/commands), [`invariants`](../packages/runtime-diagnostics/invariants), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`settings`](../packages/settings/settings), [`shell`](../packages/shell/shell), [`user-approval`](../packages/interaction/user-approval) |
| [`jobs-local`](../packages/jobs/jobs-local) | `jobs` | [`agent`](../packages/core/agent), [`jobs`](../packages/jobs/jobs), [`scope`](../packages/core/scope), [`timeout`](../packages/util/timeout) |
| [`session-title-llm`](../packages/session/session-title-llm) | `session` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-title`](../packages/session/session-title), [`timeout`](../packages/util/timeout) |
| [`bash-sandbox`](../packages/shell/bash-sandbox) | `shell` | [`bash-local`](../packages/shell/bash-local), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`shell`](../packages/shell/shell) |
| [`pwsh-sandbox`](../packages/shell/pwsh-sandbox) | `shell` | [`pwsh-local`](../packages/shell/pwsh-local), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`shell`](../packages/shell/shell) |
| [`terminal-bash`](../packages/terminal/terminal-bash) | `terminal` | [`agent`](../packages/core/agent), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`subprocess`](../packages/subprocess/subprocess), [`terminal`](../packages/terminal/terminal) |
| [`token-meter`](../packages/llm/token-meter) | `llm` | [`compaction`](../packages/compaction/compaction), [`llm`](../packages/llm/llm), [`llm-retry`](../packages/llm/llm-retry), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection) |
| [`agent-loop`](../packages/core/agent-loop) | `core` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`settings`](../packages/settings/settings), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`agent-tool-presentation`](../packages/core/agent-tool-presentation) | `core` | [`tools`](../packages/core/tools) |
| [`tool-goal`](../packages/goal/tool-goal) | `goal` | [`agent`](../packages/core/agent), [`goal`](../packages/goal/goal), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`tool-fs`](../packages/fs/tool-fs) | `fs` | [`attachment`](../packages/attachment/attachment), [`fs`](../packages/fs/fs), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`user-approval`](../packages/interaction/user-approval) |
| [`tool-fs-search`](../packages/fs/tool-fs-search) | `fs` | [`llm`](../packages/llm/llm), [`output-retention`](../packages/util/output-retention), [`session`](../packages/core/session), [`spill`](../packages/spill/spill), [`subprocess`](../packages/subprocess/subprocess), [`system-prompt`](../packages/core/system-prompt), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`tool-str-replace-editor`](../packages/fs/tool-str-replace-editor) | `fs` | [`fs`](../packages/fs/fs), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`tools`](../packages/core/tools) |
| [`tool-skill`](../packages/skill/tool-skill) | `skill` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`skill`](../packages/skill/skill), [`tools`](../packages/core/tools) |
| [`tool-web`](../packages/web/tool-web) | `web` | [`llm`](../packages/llm/llm), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`web`](../packages/web/web) |
| [`spill-policy`](../packages/spill/spill-policy) | `spill` | [`llm`](../packages/llm/llm), [`output-retention`](../packages/util/output-retention), [`session`](../packages/core/session), [`spill`](../packages/spill/spill), [`tools`](../packages/core/tools) |
| [`tool-todo`](../packages/todo/tool-todo) | `todo` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`tools`](../packages/core/tools) |
| [`plan-mode`](../packages/plan/plan-mode) | `plan` | [`agent`](../packages/core/agent), [`commands`](../packages/interaction/commands), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`user-questions`](../packages/interaction/user-questions) |
| [`hooks-codex`](../packages/hooks/hooks-codex) | `hooks` | [`agent`](../packages/core/agent), [`hook-protocol`](../packages/hooks/hook-protocol), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`tools`](../packages/core/tools) |
| [`command-compact`](../packages/compaction/command-compact) | `compaction` | [`commands`](../packages/interaction/commands), [`compaction`](../packages/compaction/compaction) |
| [`agent-instructions`](../packages/context/agent-instructions) | `context` | [`agent`](../packages/core/agent), [`fs`](../packages/fs/fs), [`home-paths`](../packages/util/home-paths), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`tools`](../packages/core/tools) |
| [`file-reference-local`](../packages/context/file-reference-local) | `context` | [`agent`](../packages/core/agent), [`file-reference`](../packages/context/file-reference), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`cordis-host-runner`](../packages/extensions/cordis-host-runner) | `extensions` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`tools`](../packages/core/tools), [`typert-protocol`](../packages/typert/protocol) |
| [`repeat-tool-reminder`](../packages/guard/repeat-tool-reminder) | `guard` | [`agent`](../packages/core/agent), [`tools`](../packages/core/tools) |
| [`tool-call-timeout-policy`](../packages/guard/timeout-policy) | `guard` | [`llm`](../packages/llm/llm), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`tool-ask-user`](../packages/interaction/tool-ask-user) | `interaction` | [`agent`](../packages/core/agent), [`tools`](../packages/core/tools), [`user-questions`](../packages/interaction/user-questions) |
| [`tool-jobs`](../packages/jobs/tool-jobs) | `jobs` | [`agent`](../packages/core/agent), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`output-retention`](../packages/util/output-retention), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`tool-lsp`](../packages/lsp/tool-lsp) | `lsp` | [`llm`](../packages/llm/llm), [`lsp`](../packages/lsp/lsp), [`system-prompt`](../packages/core/system-prompt), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`mcp-client`](../packages/mcp/mcp-client) | `mcp` | [`attachment`](../packages/attachment/attachment), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`agent-presets`](../packages/preset/agent-presets) | `preset` | [`agent`](../packages/core/agent), [`atomic-write`](../packages/util/atomic-write), [`home-paths`](../packages/util/home-paths), [`invariants`](../packages/runtime-diagnostics/invariants), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`settings`](../packages/settings/settings), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`typert-protocol`](../packages/typert/protocol) |
| [`schedule`](../packages/schedule/schedule) | `schedule` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`tools`](../packages/core/tools) |
| [`session-checkpoint-policy`](../packages/session/session-checkpoint-policy) | `session` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`tools`](../packages/core/tools) |
| [`session-telemetry-otel`](../packages/session/session-telemetry-otel) | `session` | [`anonymous-user-id`](../packages/identity/anonymous-user-id), [`command-feedback`](../packages/feedback/command-feedback), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-telemetry`](../packages/session/session-telemetry) |
| [`session-title-all-prompts-llm`](../packages/session/session-title-all-prompts-llm) | `session` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-title`](../packages/session/session-title), [`session-title-llm`](../packages/session/session-title-llm) |
| [`session-title-first-prompt-llm`](../packages/session/session-title-first-prompt-llm) | `session` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-title`](../packages/session/session-title), [`session-title-llm`](../packages/session/session-title-llm) |
| [`shell-env`](../packages/shell/shell-env) | `shell` | [`home-paths`](../packages/util/home-paths), [`shell`](../packages/shell/shell), [`tools`](../packages/core/tools) |
| [`tool-bash-persistent`](../packages/shell/tool-bash-persistent) | `shell` | [`agent`](../packages/core/agent), [`terminal`](../packages/terminal/terminal), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`tool-pwsh-persistent`](../packages/shell/tool-pwsh-persistent) | `shell` | [`agent`](../packages/core/agent), [`terminal`](../packages/terminal/terminal), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`tool-terminal`](../packages/terminal/tool-terminal) | `terminal` | [`agent`](../packages/core/agent), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`output-retention`](../packages/util/output-retention), [`system-prompt`](../packages/core/system-prompt), [`terminal`](../packages/terminal/terminal), [`tools`](../packages/core/tools) |
| [`agent-loop-testkit`](../packages/test-support/agent-loop-testkit) | `test-support` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`llm-replay`](../packages/test-support/llm-replay) | `test-support` | [`compaction`](../packages/compaction/compaction), [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`tool-workflow`](../packages/workflow/tool-workflow) | `workflow` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`workflow`](../packages/workflow/workflow) |
| [`plugin-package-inventory-deepseek`](../packages/llm/plugin-package-inventory-deepseek) | `llm` | [`agent`](../packages/core/agent), [`agent-presets`](../packages/preset/agent-presets), [`deepseek-llm-api-extensions`](../packages/llm/deepseek-llm-api-extensions), [`session`](../packages/core/session) |
| [`session-query`](../packages/session-query/session-query) | `session-query` | [`brand`](../packages/util/brand), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`session-projection-cache`](../packages/session/session-projection-cache), [`session-title`](../packages/session/session-title), [`tool-todo`](../packages/todo/tool-todo) |
| [`acp`](../packages/acp/acp) | `acp` | [`agent`](../packages/core/agent), [`attachment`](../packages/attachment/attachment), [`llm`](../packages/llm/llm), [`mcp-client`](../packages/mcp/mcp-client), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`token-meter`](../packages/llm/token-meter), [`user-approval`](../packages/interaction/user-approval) |
| [`api-settings-controller`](../packages/api/settings-controller) | `api` | [`agent-presets`](../packages/preset/agent-presets), [`credentials`](../packages/credentials/credentials), [`native-command`](../packages/util/native-command), [`session`](../packages/core/session), [`settings`](../packages/settings/settings), [`typert-protocol`](../packages/typert/protocol) |
| [`web-app`](../packages/bundle/web-app) | `bundle` | [`shell-env`](../packages/shell/shell-env), [`system-prompt`](../packages/core/system-prompt) |
| [`compaction-tool-result-pruner`](../packages/compaction/compaction-tool-result-pruner) | `compaction` | [`compaction`](../packages/compaction/compaction), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`token-meter`](../packages/llm/token-meter) |
| [`tool-cordis`](../packages/extensions/tool-cordis) | `extensions` | [`agent`](../packages/core/agent), [`cordis-host-runner`](../packages/extensions/cordis-host-runner), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`host-plugin-inventory`](../packages/host/plugin-inventory) | `host` | [`agent-presets`](../packages/preset/agent-presets), [`brand`](../packages/util/brand), [`typert-protocol`](../packages/typert/protocol) |
| [`mcp-manager`](../packages/mcp/mcp-manager) | `mcp` | [`credentials`](../packages/credentials/credentials), [`invariants`](../packages/runtime-diagnostics/invariants), [`mcp-client`](../packages/mcp/mcp-client), [`settings`](../packages/settings/settings), [`tools`](../packages/core/tools), [`util-values`](../packages/util/values) |
| [`tool-bash`](../packages/shell/tool-bash) | `shell` | [`agent`](../packages/core/agent), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`shell`](../packages/shell/shell), [`shell-env`](../packages/shell/shell-env), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`user-approval`](../packages/interaction/user-approval) |
| [`tool-pwsh`](../packages/shell/tool-pwsh) | `shell` | [`agent`](../packages/core/agent), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`shell`](../packages/shell/shell), [`shell-env`](../packages/shell/shell-env), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`user-approval`](../packages/interaction/user-approval) |
| [`webhook`](../packages/webhook/webhook) | `webhook` | [`agent`](../packages/core/agent), [`agent-default-model`](../packages/core/agent-default-model), [`agent-presets`](../packages/preset/agent-presets), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`permission-presets`](../packages/interaction/permission-presets), [`session`](../packages/core/session), [`session-title`](../packages/session/session-title), [`workspace`](../packages/workspace/workspace) |
| [`subagent`](../packages/subagent/subagent) | `subagent` | [`agent`](../packages/core/agent), [`agent-presets`](../packages/preset/agent-presets), [`attachment`](../packages/attachment/attachment), [`invariants`](../packages/runtime-diagnostics/invariants), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`session-projection-cache`](../packages/session/session-projection-cache), [`session-query`](../packages/session-query/session-query), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`typert-protocol`](../packages/typert/protocol), [`user-approval`](../packages/interaction/user-approval), [`util-time`](../packages/util/time) |
| [`session-query-sqlite`](../packages/session-query/session-query-sqlite) | `session-query` | [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-query`](../packages/session-query/session-query) |
| [`tool-session-query`](../packages/session-query/tool-session-query) | `session-query` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`session-query`](../packages/session-query/session-query), [`system-prompt`](../packages/core/system-prompt), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`compaction-basic`](../packages/compaction/compaction-basic) | `compaction` | [`agent`](../packages/core/agent), [`commands`](../packages/interaction/commands), [`compaction`](../packages/compaction/compaction), [`compaction-tool-result-pruner`](../packages/compaction/compaction-tool-result-pruner), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`token-meter`](../packages/llm/token-meter) |
| [`session-reference`](../packages/context/session-reference) | `context` | [`agent`](../packages/core/agent), [`compaction`](../packages/compaction/compaction), [`llm`](../packages/llm/llm), [`output-retention`](../packages/util/output-retention), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`session-projection-cache`](../packages/session/session-projection-cache), [`session-query`](../packages/session-query/session-query), [`session-title`](../packages/session/session-title), [`typert-protocol`](../packages/typert/protocol) |
| [`webhook-github`](../packages/webhook/webhook-github) | `webhook` | [`credentials`](../packages/credentials/credentials), [`host-webserver`](../packages/host/webserver), [`session`](../packages/core/session), [`webhook`](../packages/webhook/webhook) |
| [`subagent-acp`](../packages/subagent/subagent-acp) | `subagent` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subagent-claude-code`](../packages/subagent/subagent-claude-code) | `subagent` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subagent-codex`](../packages/subagent/subagent-codex) | `subagent` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver) | `subagent` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`tool-subagent`](../packages/subagent/tool-subagent) | `subagent` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`settings`](../packages/settings/settings), [`subagent`](../packages/subagent/subagent), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`tool-subagent-control`](../packages/subagent/tool-subagent-control) | `subagent` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`tools`](../packages/core/tools) |
| [`hooks-claude-code`](../packages/hooks/hooks-claude-code) | `hooks` | [`agent`](../packages/core/agent), [`hook-protocol`](../packages/hooks/hook-protocol), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`subagent`](../packages/subagent/subagent), [`tools`](../packages/core/tools) |
| [`api-session-controller`](../packages/api/session-controller) | `api` | [`agent`](../packages/core/agent), [`agent-default-model`](../packages/core/agent-default-model), [`agent-presets`](../packages/preset/agent-presets), [`api-gateway`](../packages/api/gateway), [`attachment`](../packages/attachment/attachment), [`client-connection`](../packages/client/connection), [`client-file-upload`](../packages/client/file-upload), [`commands`](../packages/interaction/commands), [`file-reference`](../packages/context/file-reference), [`jobs`](../packages/jobs/jobs), [`llm`](../packages/llm/llm), [`native-command`](../packages/util/native-command), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`session-projection-cache`](../packages/session/session-projection-cache), [`session-query`](../packages/session-query/session-query), [`session-title`](../packages/session/session-title), [`skill`](../packages/skill/skill), [`subagent`](../packages/subagent/subagent), [`typert-protocol`](../packages/typert/protocol), [`typert-registry`](../packages/typert/registry), [`util-time`](../packages/util/time), [`util-workspace-path`](../packages/util/workspace-path), [`workspace`](../packages/workspace/workspace) |
| [`experimental-agent-team`](../packages/experimental/agent-team) | `experimental` | [`agent`](../packages/core/agent), [`invariants`](../packages/runtime-diagnostics/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`subagent`](../packages/subagent/subagent), [`typert-protocol`](../packages/typert/protocol) |
| [`sdk-protocol`](../packages/sdk/protocol) | `sdk` | [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent) |
| [`tool-ralph`](../packages/workflow/tool-ralph) | `workflow` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`subagent`](../packages/subagent/subagent), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`workflow`](../packages/workflow/workflow) |
| [`workflow-worker-thread`](../packages/workflow/workflow-worker-thread) | `workflow` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`tools`](../packages/core/tools), [`workflow`](../packages/workflow/workflow) |
| [`subagent-fork-in-process`](../packages/subagent/subagent-fork-in-process) | `subagent` | [`agent`](../packages/core/agent), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver) |
| [`subagent-spawn-in-process`](../packages/subagent/subagent-spawn-in-process) | `subagent` | [`subagent`](../packages/subagent/subagent), [`subagent-in-process-driver`](../packages/subagent/subagent-in-process-driver) |
| [`experimental-client-ui-agent-team`](../packages/experimental/client-ui-agent-team) | `experimental` | [`api-remotes`](../packages/api/remotes), [`api-session-controller`](../packages/api/session-controller), [`client-locale`](../packages/client/locale), [`client-ui-conversation`](../packages/client/ui-conversation), [`client-ui-primitives`](../packages/client/ui-primitives), [`client-ui-renderer`](../packages/client/ui-renderer), [`client-ui-session`](../packages/client/ui-session), [`client-ui-slots`](../packages/client/ui-slots), [`experimental-agent-team`](../packages/experimental/agent-team), [`session`](../packages/core/session), [`typert-protocol`](../packages/typert/protocol) |
| [`experimental-tool-agent-team`](../packages/experimental/tool-agent-team) | `experimental` | [`agent`](../packages/core/agent), [`experimental-agent-team`](../packages/experimental/agent-team), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`sdk-client`](../packages/sdk/client) | `sdk` | [`llm`](../packages/llm/llm), [`sdk-protocol`](../packages/sdk/protocol), [`session`](../packages/core/session) |
| [`sdk-jsonrpc-server`](../packages/sdk/server) | `sdk` | [`agent`](../packages/core/agent), [`attachment`](../packages/attachment/attachment), [`llm`](../packages/llm/llm), [`llm-deepseek`](../packages/llm/llm-deepseek), [`scope`](../packages/core/scope), [`sdk-protocol`](../packages/sdk/protocol), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent) |
| [`client-test-runtime`](../packages/test-support/client-runtime) | `test-support` | [`api-session-controller`](../packages/api/session-controller), [`api-workspace-controller`](../packages/api/workspace-controller), [`attachment`](../packages/attachment/attachment), [`client-connection`](../packages/client/connection), [`client-store`](../packages/client/store), [`client-ui-chat`](../packages/client/ui-chat), [`client-ui-conversation`](../packages/client/ui-conversation), [`client-ui-renderer`](../packages/client/ui-renderer), [`client-ui-session`](../packages/client/ui-session), [`client-ui-settings`](../packages/client/ui-settings), [`client-ui-slots`](../packages/client/ui-slots), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`typert-protocol`](../packages/typert/protocol) |
| [`subagent-dsh-sdk`](../packages/subagent/subagent-dsh-sdk) | `subagent` | [`agent`](../packages/core/agent), [`llm`](../packages/llm/llm), [`sdk-client`](../packages/sdk/client), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess) |
