---
description: "Serve Computer Use to Codex, Claude Code, and other MCP clients from the cua-mcp profile over stdio."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-mcp

English | [中文](README.zh.md)

## Summary

This experimental bundle composes the standalone `cua-mcp` profile, an MCP stdio server for Computer Use. Every DSH installation ships it; a profile manifest that selects this bundle alone lets `dsh --profile cua-mcp` serve `cua_run_code` and `cua_reset` to one MCP client. The profile is this bundle alone: no model adapter, prompt-side tool, or telemetry row loads. One connection owns one Agent whose programs keep application and window objects in memory between calls. Consent for application and pointer access is granted without a human or forwarded to the client as an elicitation; the connected harness owns the model.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Start the server

The bundle is a runtime dependency of the `dsh` installation, so a profile that selects it as its only layer loads it from the installation; no pnpm, registry, or network access is involved. Create the profile once under the Harness home (`$DSH_HOME`, by default `~/.dsh`); `dsh --profile cua-mcp` is then the stdio command, and a source checkout runs it through `pnpm dsh` after `pnpm run build`. Do not add the bundle to a profile that already composes `dsh-base`, such as the one `dsh plugin --profile cua-mcp add` creates: both compositions declare the same row ids, which is also why the Web plugin page hides this bundle while the Host inventory still reports it as optional.

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/profiles/cua-mcp"
printf '%s\n' '{ "name": "dsh-profile-cua-mcp", "private": true, "dependencies": {}, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-cua-mcp"] } } }' > "${DSH_HOME:-$HOME/.dsh}/profiles/cua-mcp/package.json"
```

The Python runtime wheel ships the same installation: write the same manifest under the home the harness passes as `DSH_HOME`, then use its executable as the stdio command:

```python
from deepseek_harness_runtime import resolve_bundled_launch_args

command = [*resolve_bundled_launch_args(), "--profile", "cua-mcp"]  # the MCP stdio command
```

### Connect a client

`dsh --profile cua-mcp` is the stdio command, and `--help` prints its own help. A client entry names the installation's `dsh` executable by absolute path, passes `--profile cua-mcp`, sets `DSH_HOME` when the server should use a Harness home other than the default, and sets `DSH_CUA_CONSENT` for the consent mode; from a source checkout the command is `node` with `<checkout>/apps/cli/lib/bin.js` as its first argument, after `pnpm run build`. For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.dsh_cua]
command = "/absolute/path/to/dsh"
args = ["--profile", "cua-mcp"]
env = { DSH_HOME = "/absolute/path/to/dsh-home", DSH_CUA_CONSENT = "elicit" }
startup_timeout_sec = 120
tool_timeout_sec = 600
enabled_tools = ["cua_run_code", "cua_reset"]
omit_tools_from = ["code_mode", "deferred"]

[mcp_servers.dsh_cua.tools.cua_run_code]
output_token_limit = 25000
```

`startup_timeout_sec = 120` covers first-run helper preparation, `tool_timeout_sec = 600` matches the default program maximum, `enabled_tools` with `omit_tools_from` exposes both tools directly instead of through tool search, and `output_token_limit` raises the `cua_run_code` output budget to 25,000 tokens. For Claude Code, register the same entry with a ten-minute tool timeout:

```sh
claude mcp add-json dsh_cua '{"type":"stdio","command":"/absolute/path/to/dsh","args":["--profile","cua-mcp"],"env":{"DSH_HOME":"/absolute/path/to/dsh-home","DSH_CUA_CONSENT":"elicit"},"timeout":600000,"alwaysLoad":true}'
```

Other clients take the same `command`, `args`, and `env` under `mcpServers`. The Claude Code and `dsh-mcp-client` entries were exercised against a real desktop; the Codex entry follows the Codex configuration reference and the `.mcp.json` of its bundled Computer Use plugin and was not exercised here. As of 2026-11-10, Codex forwards elicitations only with `approval_policy.granular.mcp_elicitations = true`. DSH's own `dsh-mcp-client` declares no elicitation capability, and Claude Code 2.1 print mode declines elicitations, so unattended runs through those clients need `DSH_CUA_CONSENT=allow`.

On macOS the profile prepares the signed Computer Use helper on first start and needs Accessibility and Screen Recording permissions for it; the [macOS provider](../cua-macos/README.md) owns that setup. This profile has no permission page, so grant both in System Settings → Privacy & Security by adding the helper application: a source checkout prepares `DSH Computer Use Dev.app` under the macOS provider package's `native/.build/prepared/<arch>/<build>/` directory, where `current.json` names the selected build; an installed package ships `DSH Computer Use.app`. Until both are granted, `await cua.getCapabilities()` reports the missing flags and application operations fail; a locked desktop fails them with `SESSION_LOCKED`. On other Hosts the profile starts without a provider: the listing carries only `cua_reset`, a `cua_run_code` call fails as `unknown tool`, and `cua_reset` returns an error naming the missing provider.

### What you get

`cua_run_code` is the Agent's DSH registration served as an MCP tool: every `tools/list` reads its name, description, and parameter schema from the tool registry, so the provider's definition is the only source, `description` is required as that definition declares, and `timeoutMs` bounds one program. The projection omits the registration's sandbox-escalation fields, `sandbox_permissions` and `justification`, and a call naming them is refused before execution; every other argument passes to the DSH tool executor unchanged, which validates them and answers unknown names, so an invalid call returns DSH's error result. The program runs as TypeScript REPL statements against the global `cua` object in the provider's retained Node environment. The result carries what the program passes to `inspect(...)`: text as text blocks and each inspected screenshot as an inline image in the exact version the program observed, so pixel coordinates in the text match the image; a program that inspects nothing returns a completion notice. The first result of a connection starts with the `cua` API reference; the tool description carries the execution rules. Programs run one at a time per connection in arrival order; a cancelled call cancels its program.

`cua_reset` discards the program environment: variables, imports, and application or window objects, and cancels a `cua_run_code` program that is still running. Application grants, native connections, and the applications themselves stay; the next program starts a fresh process and its result repeats the API reference. Use it after a conflicting declaration or an unusable environment.

The connection's Agent is created before the stdio transport opens, so the first listing already carries its registration, and disposed when the client closes stdin, which also exits the process. Application consent follows the [CUA consent rules](../cua/README.md) for that Agent: `DSH_CUA_CONSENT=allow` grants each request for the session without a human, and the default `elicit` forwards the request to the client as a form elicitation whose answers are the CUA labels; a declined form records a denial for the session, and a client without elicitation receives an error that names the `allow` mode.

-----

<a id="configuration"></a>
## Configuration

Configure the `cua-mcp` row in the profile's `cordis.patch.yml`; the bundle patch maps `DSH_CUA_CONSENT` onto it.

| Field | Default | Meaning |
|---|---|---|
| `consent` | `elicit` | `allow` grants application and pointer consent for this session without a human; `elicit` forwards each request to the MCP client. |

The patch also mounts the provider with `screenshotTarget: { longEdge: 2048, maxBytes: 2097152 }` because no model route selects a request image here, and `agentPreset: ptc` with an empty `cua-mcp` preset so the connection's Agent receives `cua_run_code` and no other model-facing rows. Override those rows by id in the profile patch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) composes the whole profile over the empty root: sessions with JSONL persistence and projections, attachments, storage for application grants, the subprocess, sandbox, approval, and filesystem seams program processes run under, tools with the native executor, the system prompt, user questions, the llm hub without an adapter, the Agent registry with the agent-loop factory, the preset registry with the empty default preset, the `computer-use` registry, the macOS provider row disabled off Darwin, and this frontend. A profile manifest that lists this bundle alone selects the composition; the launcher loads it from the installation without a template. The frontend parses the invocation with `parseCmdline`, binds stdin EOF to the launcher's bounded shutdown, and connects the official MCP server to a stdio transport after the launcher commits readiness. `cua-mcp` is not a required startup entry: the launcher reports an inactive row on stderr instead of stopping the profile.

[`server.ts`](src/server.ts) serves both tools through the protocol server's low-level `tools/list` and `tools/call` handlers: the listing projects the Agent's `cua_run_code` registration, checked against the protocol's tool type, beside the hand-written `cua_reset`. The connection's Agent mounts the registry's default preset and records the launch directory. A `cua_run_code` call runs through `ctx.tools.execute` inside `ctx.agents.withInitiator` with the Agent and the request signal and no model step, so the Session log carries nested `tool/ptc-dispatch` events but no root `tool/call`; [`projection.ts`](src/projection.ts) renders the result and its deferred screenshot contexts, reading each image through `ctx.cuaPrograms.screenshotRequestTarget`. `cua_reset` calls `ctx.cuaPrograms.reset`. [`consent.ts`](src/consent.ts) is the `user-questions/request` answerer for that Agent.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Shared CUA package](../cua/README.md) — the object API, consent rules, and `cua_run_code`.
- [macOS provider](../cua-macos/README.md) — helper preparation, permissions, and platform guidance.
- [Computer use](../../../docs/subsystems/computer-use.md) and [MCP](../../../docs/subsystems/mcp.md) — subsystem references.
- [Profile composition](../../boot/app-boot/README.md) — bundle layers and patch lifetimes.
- [Decision record](../../../.agents/notes/implemented/architecture/2026-11-09-computer-use-mcp-server.md) — why the server runs inside a profile and owns one Agent per connection.

-----

<a id="model-experience"></a>
## Model Experience

### External harness model

#### What the model sees

The connected harness's model sees the Agent's `cua_run_code` definition, `cua_reset`, and the server instructions from `tools/list` and `initialize`. The first `cua_run_code` result of a connection, and the first after `cua_reset`, begins with the `cua` API reference the provider registered; later results carry only program output and captured screenshots. No DSH model request exists in this profile.

#### Token effect

The tool description carries the 2,200-character execution rules of the registration; the first result adds the API reference, about 13,000 characters with the current macOS provider, once per connection or reset, about 3,300 tokens by the repository's four-character estimate. Screenshots are inline images at the provider's `screenshotTarget` size. Clients cap tool output; the documented Codex configuration raises the `cua_run_code` budget to 25,000 tokens. Clients also cap tool descriptions: Claude Code 2.1.309 forwards the first 4,096 characters of an MCP tool description and appends `… [truncated]`; DSH's `dsh-mcp-client` forwards a 20,000-character description intact. The registration's description fits that budget; the reference does not and travels in the first result.

#### KV Cache effect

The tool catalog and instructions are stable for one installation. The first result's reference text changes only with the installed CUA packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS Hosts have a provider; the Windows provider mounts here once it exists. Other Hosts list only `cua_reset`: a `cua_run_code` call fails as `unknown tool`, and `cua_reset` names the missing provider.
- Elicitation uses the 2025 MCP request model; a client that negotiates the 2026-07-28 revision receives an error for consent requests and should use `DSH_CUA_CONSENT=allow`.
- Program sandbox escalation and the raw `cua` tool are not exposed; `DSH_PERMISSION_MODE` selects the launch-time file sandbox of program processes, and its `workspace-write` root is the directory the client started the server in, which some clients set to `/`. Override the `sandbox-policy` row's `workspaceRoot` in the profile patch to pin it.
- The registration's description still carries the PTC sandbox-escalation guidance ("A sandbox escalation approves this complete program …"); a program that follows it is refused before execution and told that `DSH_PERMISSION_MODE` selects the sandbox.
- A provider description longer than 4,096 characters reaches Claude Code 2.1.309 models cut; the projection does not shorten it.
- Root tool calls are not Session events; the connected harness's transcript is the record of calls and results.
- The patch lists the profile's dependency closure explicitly; a new service injection in the CUA or PTC packages leaves the provider row inactive, reported on stderr, and `cua_run_code` out of the listing until the patch adds the row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
