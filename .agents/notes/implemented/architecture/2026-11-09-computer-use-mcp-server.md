# Agent Note: Serve Computer Use to other harnesses as an MCP server

Status: implemented

English | [中文](2026-11-09-computer-use-mcp-server.zh.md)

## Problem

Computer Use training data should come from several agent harnesses, not only from DSH sessions. Codex, Claude Code, and in-house harnesses connect to capabilities through MCP stdio servers; Codex's own Computer Use is a stdio server with a persistent JavaScript REPL. DSH's `cua_run_code` already composes a retained program environment, consent, screenshots, and native connections per Agent, but only a DSH model turn could call it. The MCP form must keep those owners, persist program state across calls, and start from one documented command on every DSH distribution.

## Decision

`@deepseek-ai/dsh-cua-mcp` is an experimental bundle in `OPTIONAL_BUNDLES` that composes the standalone `cua-mcp` profile from one insert over the empty root and declares that profile through `dsh.bundle.profile`, so the first `dsh --profile cua-mcp` initializes the profile from this single bundle. It is the only MCP application path; no package bin or SDK escape exists, and the bundle stays out of `PROFILE_TEMPLATES` because templates cannot name experimental packages.

The server runs inside the profile process and calls `ctx.tools.execute` with the connection's Agent and no model step. One stdio connection owns one Agent: creation before the stdio transport opens, disposal at stdin EOF. Agent ownership already selects the retained program process, native connection, and session-scoped grants, so connection lifetime and state lifetime coincide. The empty default preset `cua-mcp` gives that Agent `cua_run_code` and nothing else, because the provider registers program tools only for composed presets.

Two tools form the surface. `cua_run_code` is the Agent's DSH registration served through the protocol server's low-level `tools/list` and `tools/call` handlers: each listing projects name, description, and parameters from the tool registry, and a call passes its arguments to the tool executor unchanged inside the Agent's initiator scope, so the provider's definition is the only schema, `description` is required as that definition declares, and validation and unknown names are answered by DSH; the one trim is the registration's sandbox-escalation fields, which the projection omits and a call may not name; the first result per connection carries the `cua` API reference, the provider's guidance. `cua_reset` releases the program environment through `ctx.cuaPrograms.reset`, which the CUA provider now exposes beside `screenshotRequestTarget`. The projection delivers each deferred screenshot as the request version the program observed, so coordinates in program text match the delivered image. The provider's new `screenshotTarget` configuration replaces the model-route lookup that a profile without a model cannot satisfy.

Consent has two modes. `DSH_CUA_CONSENT=allow` answers every approval question of the connection's Agent with its approving label for the session. The default `elicit` forwards each question to the client as a form elicitation whose enum is the question's labels. No Session event is added: the training side consumes MCP tool results, and the connected harness's transcript records calls; DSH retains nested `tool/ptc-dispatch` events for diagnosis.

The composition lists its dependency closure, twenty-five rows, instead of layering on `dsh-base`: no model adapter, prompt-side tool, telemetry, or session-management row loads, and a new service injection in the CUA or PTC packages fails the required startup entry loudly until the patch adds the row. Initialization needs no `dsh plugin` step, so the Python runtime wheel and offline training Hosts need no registry access. `--print-client-config codex|claude-code|json` renders the client entry for the exact installation.

## Alternatives considered

**An MCP server that launches `dsh --profile sdk` through the TypeScript SDK.** The SDK protocol has no request that runs a tool without a model turn; adding one changes the protocol and both SDK clients, and screenshots would cross a second process boundary.

**A standalone CUA server outside the harness, like Codex's REPL.** Consent, sandboxing, logging, screenshot admission, and helper lifecycle would be rewritten. The in-profile server reuses those owners and remains the basis for a later extraction.

**A `turn_ended` hidden tool with client hooks.** Its only use would be writing the client's turn boundaries into a log nobody consumes; held keys already release when a program settles.

**Session events for root MCP calls.** The data consumers need only MCP results; a `tool/call` without a model step would invent a step the Session never ran.

**Exposing the raw `cua` tool or program sandbox escalation.** Raw operations need per-method schemas the external model would relearn, and escalation needs an approval answerer the profile does not have.

**A profile frontend layered on `dsh-base` with model rows disabled.** The composed profile carried about a hundred rows without a consumer: model adapters, web tools, subagents, compaction, telemetry, and session management. The explicit closure is a quarter of that and fails loud on drift.

**A `dsh plugin enable|disable` subcommand that selects the shipped bundle.** It duplicated the plugin manager's manifest-only selection inside the launcher and still produced a base-backed profile; a bundle-declared profile needs no step.

**A hand-written MCP schema and description for `cua_run_code`.** The second copy drifted within days: 663 against 2,164 characters of description and an optional against a required `description`. Projecting the registration removes the copy; the SDK's `registerTool` accepts only Standard Schema values and refuses to share `tools/list` and `tools/call` with custom handlers, so both tools use the low-level handlers.

**The `cua` API reference inside the tool description.** Claude Code 2.1.309 forwards the first 4,096 characters of an MCP tool description and appends `… [truncated]`, measured on 2026-11-10 with a 20,000-character probe description; `dsh-mcp-client` forwards the same description intact. The reference is about 13,000 characters, so it travels in the first result of each environment, and the registration's 2,200-character description stays within the budget.

## Consequences

Every installation carries the bundle and its optional macOS provider dependency; `verify-default-product-isolation` keeps it out of default templates. The required startup entry `cua-mcp` fails the profile loudly when the frontend cannot activate. Hosts without a provider list only `cua_reset`, and a `cua_run_code` call fails as `unknown tool`. Clients see state loss on process exit, `cua_reset`, or Agent disposal and recreate objects. Consent elicitation depends on the 2025 MCP request model; clients on the 2026-07-28 revision use `allow`. The tool description and the reference text in the first result are pinned by the profile's expected-output test and change with the installed CUA packages. A provider description longer than 4,096 characters reaches Claude Code models cut.
