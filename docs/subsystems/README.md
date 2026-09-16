# Subsystems

English | [中文](README.zh.md)

One page per subsystem of the DeepSeek Harness: what it is, the data structures it moves, and — where a `ctx` service or event scope backs it — a generated **Cordis API** section carrying its service and event reference. The folder complements [architecture.md](../architecture.md), which describes *behavior* across subsystems (the service map, the session/turn/step lifecycle, the event taxonomy); each page here is the reference for one subsystem's vocabulary and wiring.

| Page | Owns |
|---|---|
| [boot.md](boot.md) | Current-profile plugin management and launcher reload coordination |
| [core.md](core.md) | how `packages/core` controls the agent loop: the package-by-package loop description, agent creation and ownership (`AgentHandle`), the `Agent` handle's delivery/cancellation/interception contracts, and the repo-wide type patterns (`…Map → derived-union`, branded ids) |
| [llm-streaming.md](llm-streaming.md) | the `packages/llm` conversation types — `Message`/`ContentBlock`, the assembled model request, the `StreamChunk` wire protocol and adapter contract, `BlockAssembler`, and the `LlmAdapter` provider contract |
| [token-meter.md](token-meter.md) | immutable scalar and positional replay measurements with consumed-log revisions |
| [scope.md](scope.md) | scoped registration identity, dispatch carriers, and the owned `Scope` context |
| [typert.md](typert.md) | Remote invocation descriptors, lookup/Context declarations, Typert registries, and the Host Gateway/Client API boundaries |
| [goal.md](goal.md) | persisted goal identity, lifecycle snapshots, activation, change records, and round attribution |
| [schedule.md](schedule.md) | Session-local reminder records, durable transitions, active views, and ordinary-conversation delivery |
| [todo.md](todo.md) | the todo package's whole-list item type, durable event ownership, projection, and open-turn invariant |
| [commands.md](commands.md) | the human-command registry service: definitions, adapter discovery, direct invocation, results, and parsing views |
| [session.md](session.md) | the full `SessionEventMap` variant catalog, `TurnEndReason`, `deriveMessages()`, execution enclosure, and standalone events |
| [persistence.md](persistence.md) | the durability seam: `SessionPersistence`, the JSONL provider, `session/flush`, crash recovery, `SessionHeader` |
| [settings.md](settings.md) | the user-settings seam: `SettingsNamespace` registration, layered resolution (defaults → composition `base` → user document), owner scopes, hot commits |
| [credentials.md](credentials.md) | the credential seam: `CredentialRef` references (never values) in configuration, per-operation resolution, UI-safe `CredentialInfo`, provider source layers |
| [session-query.md](session-query.md) | logical records, bounded exact-event reads, relationship traces, semantic filters/documents, and full-text result pages |
| [feedback.md](feedback.md) | lifecycle-bound per-message feedback records, optimistic versions, sidecar persistence, and the Host Remote contract |
| [session-title.md](session-title.md) | durable title snapshots, cited source-message seqs, and the asynchronous provider contract |
| [session-reference.md](session-reference.md) | structured cross-session references: `SessionReferenceInput`/`Candidate`, prepared message contexts, the stable error taxonomy |
| [system-prompt.md](system-prompt.md) | per-assembly context, tool-provider results, prompt sections, and cooperative assembly |
| [tools.md](tools.md) | `ToolDefinition` full fields, the schema DSL, `ToolExecution`/`ToolResult`, tool-presentation UI types, and the guarded execution pipeline |
| [mcp.md](mcp.md) | external MCP connections, scoped tools and resources, server instructions, protocol results, and configuration ownership |
| [user-questions.md](user-questions.md) | the UI-backed human question/answer seam: `AskUserQuestionRequest`, answer/options vocabulary, provider API, error taxonomy |
| [approval.md](approval.md) | the one-shot user-approval seam: `ApprovalRequest`, `ApprovalOutcome`, per-session policy, audit events, and answerer contracts |
| [attachment.md](attachment.md) | durable image identity and metadata, validation inputs, verified reads, and the `AttachmentStore` seam |
| [shell.md](shell.md) | the shell executor seam: `ShellExecRequest`/`Spec`, `ShellRunResult`, background `ShellProcess` handles |
| [subprocess.md](subprocess.md) | the subprocess seam: fully-explicit `SubprocessSpawnSpec`, offset-based output readers, unclassified `SubprocessOutcome`, and the managed `DSH_*` environment vocabulary |
| [ssh.md](ssh.md) | the POSIX SSH connection and remote filesystem, subprocess and sandbox providers |
| [terminal.md](terminal.md) | persistent terminal ids, backend/session contracts, send readiness, bounded reads, and owner-visible snapshots |
| [sandbox.md](sandbox.md) | per-session policy resolution and the process-confinement seam: file-effect modes, execution/provider policies, `ConfinedArgv`, enforcement and fail-closed errors |
| [ptc-runtime.md](ptc-runtime.md) | the PTC execution seam: `PtcRunRequest`/`Result`, binding namespaces, captured logs, the `PtcRunFailure` taxonomy |
| [computer-use.md](computer-use.md) | exclusive named computer-use provider registration and Cua Driver integration choices |
| [browser-use.md](browser-use.md) | exclusive named browser-use registration, provider choices, and per-Session browser ownership |
| [extensions.md](extensions.md) | versioned dynamic Cordis Plugins and Packages, Host/Client activation, approval, runtime inspection, and lifecycle teardown |
| [filesystem.md](filesystem.md) | the filesystem seam: `FsTarget`, read/write/edit outcomes, observed-file state, `FsErrorCode` |
| [lsp.md](lsp.md) | the LSP navigation seam: `LspQueryRequest`/`Result`, `LspProvider`/`Service`, four operations, `LspError` |
| [skills.md](skills.md) | the skill service: discovery priority, `SkillSummary`/`SkillDefinition`, session-prefix catalog, model-facing `skill` loading |
| [compaction.md](compaction.md) | the compaction seam: the `compaction/*` session events, `CompactionResult`, the `CompactionEngine` interface |
| [subagent.md](subagent.md) | the subagent seam: the named-provider registry, `SubagentStartRequest`/`Result`/`Run`, the start-time-vs-runtime capability split |
| [agent-team.md](agent-team.md) | Agent Teams: implicit Lead identity, named continuable teammates, durable peer mailbox, and shared task DAG |
| [web.md](web.md) | the web access seam: `WebSearchRequest`/`Result`, `WebFetchRequest`/`Result`, `WebFetchBody`, provider availability, `WebError` |
| [spill.md](spill.md) | the spill storage seam: `SaveTextSpill`, `SpillOwner`/`SpillSource`, `SpillRef`, the branded `SpillLocator` |
| [workflow.md](workflow.md) | the workflow seam: `WorkflowStartRequest`, `WorkflowMeta`, `WorkflowRun`/`Result`, the `workflow/*` event payloads, `WorkflowError` fatality |
| [jobs.md](jobs.md) | the background-job runtime: branded `JobId`s, the producer contract, consumer views, and `ctx.jobs` service behavior |
| [permission-presets.md](permission-presets.md) | the permission-preset layer: `PresetSpec`/`PresetOption`, the derived `custom` state, the log-only `permission/preset` event |
| [plan.md](plan.md) | plan mode: the log-only `plan/mode` state, pending-selection flush, `PlanModeConfig`, the `exit_plan_mode` review arc |
| [invariants.md](invariants.md) | the runtime-invariant registry: selection `Config`, `InvariantInstaller`/`InvariantFailure`, the empty-companion contract |
| [web-server.md](web-server.md) | the HTTP carrier: `WebRouteKind`/`WebRoute`, match order, the claimable fallback seat, index taps |
| [webhook.md](webhook.md) | authenticated provider deliveries, arbitrary programmatic rules, and fire-and-forget Workspace Session creation |
| [storage.md](storage.md) | the storage subsystem: the backend contract (`StorageBackend`), `StorageForms`, `DomainSpec`/`Domain`, `domain/changed` |
| [workspace.md](workspace.md) | the workspace registry: `Workspace`/`WorkspaceId`, registration and resolution, the session `cwd` relationship |
| [web-client.md](web-client.md) | the browser architecture: boot, Remote communication, paired Client models, UI adapters, Conversation assembly, Slots, and reconnect semantics |
| [client-modules.md](client-modules.md) | the web plugin table: `dsh.client` declarations, `WebBootGraph` wire composition, the bundle route and index tap |
| [slots.md](slots.md) | typed Web UI composition: declaration ownership, cardinality and scope, framework and feature injection, props derivation, and the shipped hierarchy |
| [client-resources.md](client-resources.md) | the client resource model: `dsh-resource://<type>/…` addresses, protocol providers and `ResourceProtocolMap`, the `useResource` global hook and its states, pins and release |
| [sidebar-right.md](sidebar-right.md) | the right Sidebar: resource and navigation addresses, tab-type registration and routing, the `ctx.sidebarRight` navigation service, the pane-tab slots and owner props, the resource model, and the Workspace Files service |
| [conversation.md](conversation.md) | target-neutral Session-event assembly: Context identity, Location data, replay paths, view builders, and target-owned render nodes |
| [session-projection.md](session-projection.md) | the projection seam: `SessionProjectionMap`, the pure `ProjectionDefinition` unit, `ProjectionSnapshot`'s consistent cut, the change feed |
| [session-telemetry.md](session-telemetry.md) | the outbound session-reporting capability seam: `SessionTelemetryRecord`/`SessionTelemetrySeverity`, the `SessionTelemetrySink` contract, and the `session-telemetry/record` redact waterfall |

> Type declarations and their JSDoc on these pages are source-equivalent and drift-checked by `pnpm run verify-type-equiv` (see [development.md](../development.md#documenting-types-verbatim-ts-type-equiv)). Ordinary blocks preserve complete declarations; `public-api` blocks preserve body-stripped public class declarations. Cordis services and events use each page's generated **Cordis API** section.
