# Agent Note: Serve Computer Use to other harnesses as an MCP server

Status: implemented

English | [中文](2026-11-09-computer-use-mcp-server.zh.md)

## Problem

Computer Use training data should come from several agent harnesses, not only from DSH sessions. Codex, Claude Code, and in-house harnesses connect to capabilities through MCP stdio servers; Codex's own Computer Use is a stdio server with a persistent JavaScript REPL. DSH's `cua_run_code` already composes a retained program environment, consent, screenshots, and native connections per Agent, but only a DSH model turn could call it. The MCP form must keep those owners, persist program state across calls, and start from one documented command on every DSH distribution.

## Decision

`@deepseek-ai/dsh-cua-mcp` is an experimental bundle in `OPTIONAL_BUNDLES`: a profile frontend over `dsh-base` selected with `dsh plugin --profile cua-mcp enable @deepseek-ai/dsh-cua-mcp` and started with `dsh --profile cua-mcp`. It is the only MCP application path; no package bin or SDK escape exists, and a shipped profile template waits for CUA promotion because templates cannot name experimental packages.

The server runs inside the profile process and calls `ctx.tools.execute` with the connection's Agent and no model step. One stdio connection owns one Agent: creation after client initialization, disposal at stdin EOF. Agent ownership already selects the retained program process, native connection, and session-scoped grants, so connection lifetime and state lifetime coincide. The empty default preset `cua-mcp` gives that Agent `cua_run_code` and nothing else, because the provider registers program tools only for composed presets.

Two tools form the surface. `cua_run_code` forwards `code`, an optional `description` defaulting to `CUA program`, and `timeoutMs`; its first result per connection carries the execution rules and the complete `cua` API reference, keeping the tool description within client limits. `cua_reset` releases the program environment through `ctx.cuaPrograms.reset`, which the CUA provider now exposes beside `screenshotRequestTarget`. The projection delivers each deferred screenshot as the request version the program observed, so coordinates in program text match the delivered image. The provider's new `screenshotTarget` configuration replaces the model-route lookup that a profile without a model cannot satisfy.

Consent has two modes. `DSH_CUA_CONSENT=allow` answers every approval question of the connection's Agent with its approving label for the session. The default `elicit` forwards each question to the client as a form elicitation whose enum is the question's labels. No Session event is added: the training side consumes MCP tool results, and the connected harness's transcript records calls; DSH retains nested `tool/ptc-dispatch` events for diagnosis.

`dsh plugin enable|disable` selects installed bundles by editing `dsh.profile.bundles` without pnpm, the same operation as the Plugins page switch, so the Python runtime wheel and offline training Hosts need no registry access. `--print-client-config codex|claude-code|json` renders the client entry for the exact installation.

## Alternatives considered

**An MCP server that launches `dsh --profile sdk` through the TypeScript SDK.** The SDK protocol has no request that runs a tool without a model turn; adding one changes the protocol and both SDK clients, and screenshots would cross a second process boundary.

**A standalone CUA server outside the harness, like Codex's REPL.** Consent, sandboxing, logging, screenshot admission, and helper lifecycle would be rewritten. The in-profile server reuses those owners and remains the basis for a later extraction.

**A `turn_ended` hidden tool with client hooks.** Its only use would be writing the client's turn boundaries into a log nobody consumes; held keys already release when a program settles.

**Session events for root MCP calls.** The data consumers need only MCP results; a `tool/call` without a model step would invent a step the Session never ran.

**Exposing the raw `cua` tool or program sandbox escalation.** Raw operations need per-method schemas the external model would relearn, and escalation needs an approval answerer the profile does not have.

## Consequences

Every installation carries the bundle and its optional macOS provider dependency; `verify-default-product-isolation` keeps it out of default templates. The required startup entry `cua-mcp` fails the profile loudly when the frontend cannot activate. Clients see state loss on process exit, `cua_reset`, or Agent disposal and recreate objects. Consent elicitation depends on the 2025 MCP request model; clients on the 2026-07-28 revision use `allow`. The reference text in the first result is pinned by the profile's expected-output test and changes with the installed CUA packages.
