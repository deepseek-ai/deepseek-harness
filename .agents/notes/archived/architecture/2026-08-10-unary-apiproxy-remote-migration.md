# Agent Note: Place unary browser operations on owning Remote services

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-unary-apiproxy-remote-migration.zh.md)

## Problem

The Host API Proxy duplicated simple unary operations across business Services, API Proxy interfaces, Zod schemas, route tables, client stubs, and Client callers. [Typert Remote calls](2026-08-02-typert-remote-method-calls.md) already let a business package own this class of call, but moving an endpoint without its lifecycle and projection policy could change observable behavior.

Agent-bound calls require particular care. Shared lookup policy reuses live Agents, resumes ordinary cold Sessions with their recorded presets, deduplicates concurrent resumes, and rejects subagent-owned identities. Skill listing instead must inspect a Session without activating its Agent. Settings and preset operations keep their Host-owned document paths out of browser requests; Session file links preserve their caller-resolved path behavior.

## Decision

Simple unary operations live on their natural business Remote owner. The business package owns the Remote signature and Host adaptation; `@deepseek-ai/dsh-api-remotes/client` selects its generated contribution; the Client package owns presentation joins. Connection owns the transport envelope and exact Fetch route registry, and no API Proxy service remains.

| Former API Proxy operation | Destination | Owner and preserved behavior |
|---|---|---|
| `session.rename` | `sessionTitle/rename` | `SessionTitleService` resolves the Session through the shared lookup policy and returns the title event sequence. |
| `command.list`, `command.execute` | `commands/list`, `commands/execute` | `CommandRuntime` preserves Agent lookup, unmatched commands, and caller cancellation. |
| `llm.providers` | `llm/listProviders`, `llm/listConfigurableProviders` | `LlmRuntime` owns provider facts; Clients join live and configurable rows. |
| `llm.discoverModels` | `llm/discoverModels` | `LlmRuntime` preserves provider discovery, cancellation, and sanitized failures. |
| `llm.models` | `session/modelCatalog` | `SessionController` owns the Host-generation catalog, default selection, and isolated provider failures. |
| `credentials.describe`, `credentials.set`, `credentials.unset` | `credentials/describe`, `credentials/set`, `credentials/unset` | `CredentialsController` preserves reference validation, field projection, provider diagnostics, and refusal mapping. |
| `settings.describe`, `settings.update`, `settings.replace`, `settings.mutate` | Equivalent `settings/*` methods | `SettingsController` preserves redaction, mutation semantics, revision checks, and provider failures. |
| `settings.openDocument` | `settings/openSettingsDocument` | `SettingsController` prepares the provider-owned document and opens it with text-editor intent. |
| `agentPreset.read`, `agentPreset.copy`, `agentPreset.remove` | Equivalent `agentPresets/*` methods | `AgentPresetService` owns document reads, copies, and removals. |
| `agentPreset.openDocument` | `settings/openAgentPresetDirectory` | `SettingsController` resolves the preset directory and returns its path when native opening is unavailable. |
| `subagent.interrupt` | `subagents/interruptByParent` | The subagent service preserves parent authority without activating either Agent. |
| `workspace.list`, `workspace.insertSessionBefore`, `workspace.archiveSession` | Equivalent `workspace/*` methods | The Workspace registry owns detached snapshots and serialized mutations. |
| `skill.list` | `skills/list` | `SessionSkillCatalog` observes the Session and its recorded preset, uses a live Agent only when one already exists, and never activates an Agent for listing. |
| `fileReferences/list` | `fileReferences/list` | `SessionFileReferences` supplies the Session Controller's established Agent lookup to the provider; cold lookup behavior remains unchanged. |
| `host.openPath` | `session/openWorkspacePath` | The Session-aware Client resolves relative paths against the known workspace before `SessionController` hands them to the native opener. |
| `host.describe` | `$events` ready frame plus capability queries | API Remotes sends the Host home with generation readiness, and consumers read it as a plain value through `ctx.remote.$host.home` beside `$host.isLoopback`; Settings and Session controllers report their native-open capabilities when the corresponding page appears. Unused process metadata is not sent. |
| `session.export` | `GET`/`HEAD /api/session.export` | `session-log-export` registers an exact Connection Fetch route and streams the ZIP without a JSON Remote envelope. |

The shared Agent and Session resolver remains the authority for endpoints that accept those objects. It provides the same live reuse, cold restoration, concurrent deduplication, preset setup, persistence failures, and subagent ownership fence that legacy API Proxy calls used. The resolver raises a `RemoteError` carrying its own code — `session/not-found` or `session/agent-busy` — and the Gateway encodes that code, message, and details onto the wire unchanged, so a lookup refusal stays distinguishable from `gateway/internal` ([failure vocabulary](2026-08-28-ctx-remote-failure-vocabulary.md)).

The native path implementation lives in `@deepseek-ai/dsh-native-command`. Settings controllers select Host-owned targets, while Session-aware Clients resolve workspace paths before calling `SessionController`; the utility only performs platform detection, WSL translation, browser preference, text-editor intent, and shell-free command execution.

## Browser authentication

Connection authenticates the complete `/api` request before choosing a Typert endpoint or exact Fetch route. Remote calls and Session-log downloads therefore require the same browser session and Host/Origin checks.

## Verification

Focused Host and Client tests cover Remote calls, lookup and no-activation policy, native opening, error projection, and removal of legacy routes. The repository build generates and consumes the selected Remote contributions before building the Web application.

## Alternatives considered

**Keep simple calls in the API Proxy.** Rejected because it preserves duplicate interfaces, schemas, route rows, stubs, and result projections after a business owner exists.

**Keep `host.describe`.** Rejected because one bootstrap call coupled Connection readiness to unrelated process and business facts. The generation-ready frame carries the only lifecycle fact needed immediately, and capability-owning pages query their domains when shown.

**Publish every business capability in the generation-ready frame.** Rejected because those values have no common update lifecycle. Only the stable Host home belongs to Connection; each business owner answers its own current capability.

**Represent Session export as a Remote.** Rejected because the browser download manager consumes a streamed HTTP response rather than a JSON result. An exact registered Fetch route keeps ownership in the feature package without adding a second gateway.

**Put native opening in one controller.** Rejected because Session and Settings select different authorized targets. A Host utility avoids controller-to-controller imports without making the browser authoritative for filesystem targets.

## Consequences

Business owners and Client consumers each define one side of a unary operation, while Connection owns authentication, transport, response envelopes, exact Fetch routes, and generation state. Removing the legacy client timeout is the accepted observable transport change; business results, cancellation, lifecycle policy, filtering, and native-path authority remain owned by their existing domains.

Generated Remote artifacts and the explicit API Remotes assembly become required whenever a Remote signature or selected package changes.
