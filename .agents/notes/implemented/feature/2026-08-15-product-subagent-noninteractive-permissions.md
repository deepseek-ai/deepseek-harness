# Agent Note: Product subagents use Profile-selected non-interactive permissions

Status: implemented

English | [中文](2026-08-15-product-subagent-noninteractive-permissions.zh.md)

## Problem

The [Claude Code and Codex product providers](2026-08-04-claude-code-and-codex-subagent-backends.md) run without a human interface. Native permission prompts, user dialogs, or MCP elicitation therefore cannot wait for a person, but relying on either product's ambient default can still select an interactive mode. A deployment also needs to choose broader native modes without giving the parent model or one tool call a way to raise its own authority.

A failed product run previously reached the [subagent seam](2026-06-21-subagent-capability-seam.md) only as a stop reason. Logs could retain the product error, but the foreground parent and a [one-shot background Job](../../archived/feature/2026-08-12-product-subagent-one-shot-background-tasks.md) could not distinguish a permission refusal from another failure. Reusing assistant output for that fact would misattribute infrastructure detail to the child model.

## Decision

Each product Provider owns its own Profile-level `permissionMode` value. The two Config fields deliberately use the products' native names rather than a shared restricted/automatic/full abstraction. The Provider fixes the resolved value for every run from that plugin instance. The subagent tool schema and `SubagentStartRequest` contain no permission field, so a model or individual delegation cannot change it.

### Claude Code

Claude Code defaults to `dontAsk` and accepts only the native non-interactive modes supported by the pinned Agent SDK:

| Value | Native behavior |
| --- | --- |
| `dontAsk` | Deny operations that are not already authorized instead of prompting. |
| `acceptEdits` | Accept edits; deny any remaining permission prompt through the unattended callback. |
| `auto` | Let Claude Code's native classifier allow or deny permission requests. |
| `plan` | Use planning mode, deny execution approval, and return the completed plan as the final answer. |
| `bypassPermissions` | Set the SDK's explicit dangerous confirmation and bypass permission checks. |

The Provider continues to omit `settingSources`: an optional instance-level model is a separate direct SDK override, while Claude Code remains the owner of user, project, and local settings, authentication, tools, and sandbox behavior outside the selected mode.

Every query disables `AskUserQuestion`. Non-bypass permission callbacks deny instead of returning the SDK's indefinitely blocking `null`; plan mode also places `ExitPlanMode` in `disallowedTools`, so native allow rules cannot switch the unattended query back to execution. MCP elicitation is declined; the supported refusal dialog is cancelled; undeclared dialog kinds use the SDK's no-dialog failure behavior. A native `permission_denied` message records the same operation-local fact. These paths do not create an approval session, queue, cache, or retry loop.

### Codex

Codex defaults to `never` and accepts the three native non-interactive modes exposed by Codex 0.149.1. The Provider starts the fixed app-server command, then maps the selected mode into official `thread/start` fields because CLI-global permission flags do not configure threads created later by an app-server client:

| Value | `thread/start` fields | Native behavior |
| --- | --- | --- |
| `never` | `approvalPolicy: never`; sandbox omitted | Never prompt; execution failures return to the model under the native sandbox. |
| `approve-for-me` | `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, `sandbox: workspace-write` | Route permission requests through Codex automatic review. |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access` | Skip approval and sandbox enforcement. |

The Provider overrides only those permission and sandbox fields. An optional instance-level model is a separate direct `thread/start` override; `CODEX_HOME`, project configuration, model-provider selection, MCP, hooks, skills, authentication, and sandbox facts not selected by the mode remain native Codex state. The wire still denies any unexpected approval, permission, user-input, or MCP request rather than opening a dynamic allow path.

### Failure diagnostic

`SubagentResult` carries an optional `diagnostic` for provider-authored, non-assistant failure detail. A Provider removes tool inputs, file contents, environment values, credentials, and raw protocol payloads before producing it. The shared out-of-process result boundary limits the complete text to 4096 UTF-8 bytes and marks truncation without splitting a character. The [minimal-diagnostics decision](../../archived/simplification/2026-08-21-product-subagent-minimal-diagnostics.md) owns both products' non-permission action categories, lifecycle stages, HTTP facts, and process outcomes carried by the same field.

Each product's permission fact contains only the effective mode, request category, unattended decision, and a fixed safe reason. Claude Code derives those facts from SDK callbacks and `permission_denied` messages. Codex derives them from app-server requests, declined items, and structured `sandboxError` terminals. Raw stderr is forwarded to the Host but is neither classified nor copied into the diagnostic. Both Providers place their failure line before the latest contributing permission fact. A successful result returns only the strict final answer; local cancellation remains `aborted` without permission detail; an unpublished startup failure still rejects `start()`. The Provider never adds either diagnostic fact to assistant output, structured output, or `subagent/end.lastAssistantMessage`.

The foreground consumer presents the stop-reason headline, then the optional diagnostic, then any partial assistant output. The one-shot background adapter stores the same diagnostic beside the stop reason in the failed Job detail. Providers that omit the field retain their previous behavior.

### Ownership and lifecycle

| Fact or resource | Owner | Observable behavior |
| --- | --- | --- |
| Profile permission choice | Each product Provider Config | Invalid, interactive, or unknown values fail during configuration. |
| Permission and sandbox semantics | Claude Code Agent SDK or Codex app-server | Each Provider passes one native mode and does not mirror product policy. |
| Interaction decisions and safe diagnostic | One product run | Concurrent runs keep independent mode, protocol, and diagnostic state. |
| Diagnostic type and byte limit | `dsh-subagent` | Consumers receive a bounded optional field separate from assistant output. |
| Foreground and Job presentation | `dsh-tool-subagent` and the generic Job runtime | Scheduling choice does not change the underlying failure fact. |
| Process cancellation and quiescence | Product Provider and `dsh-subprocess` | Result settlement still precedes idempotent whole-tree disposal. |

## Verification

Package tests pin every allowed and rejected Config value, the exact SDK and app-server field mappings, dangerous confirmations, unattended terminal responses, diagnostic sanitization and UTF-8 bound, successful-result omission, concurrent-run isolation, foreground ordering, Job detail, stderr observer disposal, and process cleanup. The real Claude Agent SDK 0.3.241 and Claude Code 2.1.241 fixture proves its safe default, restricted denial, explicit bypass, and whole-tree quiescence. The real Codex 0.149.1 app-server fixture proves that thread-level `never` overrides ambient `on-request`, automatic review starts, dangerous bypass writes only inside suite-owned temporary storage, a rejected escalation leaves no side effect or raw command or path in the diagnostic, stderr remains Host-only, and the wrapper/native tree exits. Loader composition proves non-default modes can be published without starting either product, and the keyless ACP snapshot records each product's failure diagnostic through foreground and Job presentation while the model-facing product tool schemas contain no permission parameter.

## Alternatives considered

**Use the product's ambient permission default.** A native setting may select an interactive mode and make unattended behavior deployment-dependent. The Provider must choose a non-interactive mode explicitly for every query.

**Put permission mode in the model-facing tool or each start request.** That would let task content select authority and would duplicate a Profile deployment decision on every call.

**Copy product settings or map the parent Harness sandbox.** The products do not share one permission vocabulary. Mirroring their state would create a second authority and obscure the native sandbox consequences of automatic and bypass modes.

**Forward prompts to a parent, Web client, or CLI.** The one-shot product run has no owned human-interaction lifecycle. Adding one would require durable request identity, routing, cancellation, and timeout semantics beyond this decision.

**Return raw product errors, stderr, or tool inputs.** Those values can contain commands, paths, workspace data, environment values, or credentials. A fixed safe diagnostic keeps the failure actionable without exposing the product transcript.

**Store a separate Job diagnostic.** The Job is only a scheduling adapter for the same `SubagentRun`; a second field would let foreground and background failure meanings drift.

## Consequences

Profiles can select each product's native restricted, automatic, planning/edit-accepting where supported, or bypass behavior before the Provider starts, while both safe defaults never ask a person. Broader modes remain explicit deployment choices and retain their native sandbox consequences.

Permission failures become visible to both foreground parents and one-shot background Jobs without turning infrastructure text into an assistant answer. The same field can also carry the separately owned structured failure facts. It can enter model context, Job notices, API projections, and Job UI through the ordinary consumer paths, so the Provider must sanitize and bound the complete text before result settlement.

The change adds no product session persistence, human approval channel, dynamic permission operation, progress stream, retry policy, or rollback. Other Providers remain valid without producing a diagnostic or exposing a permission-mode Config.
