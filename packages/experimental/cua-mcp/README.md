---
description: "Serve Computer Use to Codex, Claude Code, and other MCP clients from the cua-mcp profile over stdio."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-mcp

English | [中文](README.zh.md)

## Summary

This experimental bundle composes the standalone `cua-mcp` profile, an MCP stdio server for Computer Use. Every DSH installation ships it; a profile manifest that selects this bundle alone lets `dsh --profile cua-mcp` serve `cua_get_api_reference`, `cua_run_code`, and `cua_reset` to one MCP client. The profile is this bundle alone: no model adapter, prompt-side tool, or telemetry row loads. One connection owns one Agent whose programs keep application and window objects in memory between calls. Consent for application and pointer access is granted without a human or forwarded to the client as an elicitation; the connected harness owns the model.

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

`dsh --profile cua-mcp` is the stdio command, and `--help` prints its own help. A client entry names the installation's `dsh` executable by absolute path, passes `--profile cua-mcp`, sets `DSH_HOME` when the server should use a Harness home other than the default, `DSH_CUA_CONSENT` for the consent mode, and `DSH_CUA_WORKSPACE` when programs should work in a directory other than the default workspace; from a source checkout the command is `node` with `<checkout>/apps/cli/lib/bin.js` as its first argument, after `pnpm run build`. For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.dsh_cua]
command = "/absolute/path/to/dsh"
args = ["--profile", "cua-mcp"]
env = { DSH_HOME = "/absolute/path/to/dsh-home", DSH_CUA_CONSENT = "elicit" }
required = true
startup_timeout_sec = 120
tool_timeout_sec = 600
enabled_tools = ["cua_get_api_reference", "cua_run_code", "cua_reset"]
omit_tools_from = ["code_mode", "deferred"]

[mcp_servers.dsh_cua.tools.cua_run_code]
output_token_limit = 25000
```

`required = true` makes Codex wait for the server before its first model request and end the session when the server does not start; without it Codex waits `mcp_optional_startup_grace_ms`, one second by default, and the first request can go out without the three tools. `startup_timeout_sec = 120` bounds that wait and covers first-run helper preparation, `tool_timeout_sec = 600` matches the default program maximum, `enabled_tools` with `omit_tools_from` exposes the three tools directly instead of through tool search, and `output_token_limit` raises the `cua_run_code` output budget to 25,000 tokens.

`codex exec` runs with the approval policy `never`, under which Codex refuses `cua_run_code`, the one tool this server annotates as destructive and open-world, with `MCP tool call requires approval, but approval policy is never` (observed on codex-cli 0.153.2). An unattended run therefore adds `approval_mode = "approve"` to the `cua_run_code` table and sets `DSH_CUA_CONSENT = "allow"`.

For Claude Code, register the same entry with a ten-minute tool timeout:

```sh
claude mcp add-json dsh_cua '{"type":"stdio","command":"/absolute/path/to/dsh","args":["--profile","cua-mcp"],"env":{"DSH_HOME":"/absolute/path/to/dsh-home","DSH_CUA_CONSENT":"elicit"},"timeout":600000,"alwaysLoad":true}'
```

Other clients take the same `command`, `args`, and `env` under `mcpServers`. The Claude Code, `dsh-mcp-client`, and Codex entries were exercised against a real macOS desktop, Codex through `codex exec` on codex-cli 0.153.2 and 0.166.0-alpha.5.1 with `DSH_CUA_CONSENT=allow`; no client has driven a Windows desktop through this profile. Codex's interactive approval prompts and its elicitation forwarding were not exercised here; per the Codex configuration reference as of 2026-11-11, Codex forwards elicitations only with `approval_policy.granular.mcp_elicitations = true`. DSH's own `dsh-mcp-client` declares no elicitation capability, and Claude Code 2.1 print mode declines elicitations, so unattended runs through those clients need `DSH_CUA_CONSENT=allow`.

A client that allows tools by name must allow all three: without `cua_get_api_reference` its model has no `cua` API reference. Give the server a Harness home that no profile with uncompressed Session logs shares: this profile writes zstd-compressed logs under `sessions`, and a profile that sets `compression: none`, such as `sdk-minimal`, fails Session queries on a directory that holds them.

On macOS the profile prepares the signed Computer Use helper on first start and needs Accessibility and Screen Recording permissions for it; the [macOS provider](../cua-macos/README.md) owns that setup. This profile has no permission page, so grant both in System Settings → Privacy & Security by adding the helper application: a source checkout prepares `DSH Computer Use Dev.app` under the macOS provider package's `native/.build/prepared/<arch>/<build>/` directory, where `current.json` names the selected build; an installed package ships `DSH Computer Use.app`. Until both are granted, `await cua.getCapabilities()` reports the missing flags and application operations fail; a locked desktop fails them with `SESSION_LOCKED`.

On native Windows the profile mounts the [Windows provider](../cua-windows/README.md), which owns helper setup: a source checkout builds the helper with the .NET 10 SDK on PATH, and an npm installation ships none. For such an installation, name the helper with `helperPath` on the `cua-mcp-provider-windows` row in the profile's `cordis.patch.yml`: the absolute path of `dsh-cua-windows.exe`, from the extracted standalone ZIP on x64 or a matching build on ARM64. A patch replaces the row's whole config, so restate the bundle's fields:

```yaml
- id: cua-mcp-provider-windows
  config:
    agentPreset: ptc
    screenshotTarget:
      longEdge: 2048
      maxBytes: 2097152
    helperPath: 'C:\absolute\path\to\dsh-cua-windows.exe'
```

That provider does not launch applications and offers no `Always allow` grant: open the application before a program selects it, and under `elicit` every connection asks for consent again. The profile does not mount it under WSL.

On other Hosts the profile starts without a provider: the listing carries `cua_get_api_reference` and `cua_reset`, each of which returns an error naming the missing provider, and a `cua_run_code` call fails as `unknown tool`. A provider row that fails to activate, such as the Windows row without a helper, leaves the same listing, and the launcher names the failure on stderr.

### What you get

`cua_get_api_reference` returns the `cua` API reference: the guidance the provider registers for the connection's Agent, with every method signature and operating rule, which a DSH model receives in its system prompt. It takes no arguments, runs no program, and touches neither the desktop nor the program environment, so it also answers while a program is running. The server instructions ask the model to call it at the start of every conversation, and its description asks for another call when the reference has left the model's context or a program fails on an unknown `cua` method.

`cua_run_code` is the Agent's DSH registration served as an MCP tool: every `tools/list` reads its name, description, and parameter schema from the tool registry, so the provider's definition is the only source, `description` is required as that definition declares, and `timeoutMs` bounds one program. The projection omits the registration's sandbox-escalation fields, `sandbox_permissions` and `justification`, and a call naming them is refused before execution; every other argument passes to the DSH tool executor unchanged, which validates them and answers unknown names, so an invalid call returns DSH's error result. The program runs as TypeScript REPL statements against the global `cua` object in the provider's retained Node environment. The result carries what the program passes to `inspect(...)`: text as text blocks and each inspected screenshot as an inline image in the exact version the program observed, so pixel coordinates in the text match the image; a program that inspects nothing returns a completion notice. The tool description carries the execution rules. Programs start in the workspace and run one at a time per connection in arrival order; a cancelled call cancels its program. A failed call returns DSH's failure message with `isError` set and without DSH's `Error:` prefix.

`cua_reset` discards the program environment and nothing else. The program process ends, so its variables, imports, and application and window objects are gone; a `cua_run_code` program that is still running is cancelled, and the reset answers after that program has. The connection's Agent stays with its native connection and its consent decisions: an application granted for the session is not asked again, a refused one stays refused, and saved grants and the helper's system permissions are untouched. The next program starts a fresh process with a new `cua` object and selects applications again with `cua.getApp`; a program that arrives during a reset runs after it. A reset whose process cleanup fails returns an error, and programs fail until a later `cua_reset` succeeds. Use it after an unusable environment, or to keep retained state out of the next task.

The connection's Agent is created in the workspace before the stdio transport opens, so the first listing already carries its registration, and disposed when the client closes stdin, which also exits the process. The workspace is `DSH_CUA_WORKSPACE`, or `cua-mcp/workspace` under the Harness home when the variable is unset; the profile creates it, programs start there, and it is the directory the default `workspace-write` sandbox lets them write, whatever directory the client launched the server from. Application consent follows the [CUA consent rules](../cua/README.md) for that Agent: `DSH_CUA_CONSENT=allow` grants each request for the session without a human, and the default `elicit` forwards the request to the client as a form elicitation whose answers are the CUA labels; a declined form records a denial for the session, and a client without elicitation receives an error that names the `allow` mode.

-----

<a id="configuration"></a>
## Configuration

Configure the `cua-mcp` row in the profile's `cordis.patch.yml`; the bundle patch maps `DSH_CUA_CONSENT` and `DSH_CUA_WORKSPACE` onto it.

| Field | Default | Meaning |
|---|---|---|
| `consent` | `elicit` | `allow` grants application and pointer consent for this session without a human; `elicit` forwards each request to the MCP client. |
| `workspace` | `cua-mcp/workspace` under the Harness home | Absolute directory the connection's Agent works in. Programs start there and it is their `workspace-write` root. Startup creates it when missing; a relative path or a directory that cannot be created is reported on stderr and ends the process with exit code 1. |

The patch also mounts the Host's native provider, row `cua-mcp-provider` on macOS and row `cua-mcp-provider-windows` on native Windows, with `screenshotTarget: { longEdge: 2048, maxBytes: 2097152 }` because no model route selects a request image here, and `agentPreset: ptc` with an empty `cua-mcp` preset so the connection's Agent receives `cua_run_code` and no other model-facing rows. Override those rows by id in the profile patch; an override replaces the row's whole config, so restate the fields it keeps. The `sandbox-policy` row's `workspaceRoot` resolves the same directory as `workspace`; a program's root is its Agent's working directory, so that field covers only calls without a Session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) composes the whole profile over the empty root: sessions with JSONL persistence and projections, attachments, storage for application grants, the subprocess, sandbox, approval, and filesystem seams program processes run under, tools with the native executor, the system prompt, user questions, the llm hub without an adapter, the Agent registry with the agent-loop factory, the preset registry with the empty default preset, the `computer-use` registry, one native provider row per Host, macOS on Darwin and Windows on native Windows, and this frontend. A profile manifest that lists this bundle alone selects the composition; the launcher loads it from the installation without a template. The frontend parses the invocation with `parseCmdline`, binds stdin EOF to the launcher's bounded shutdown, and after the launcher commits readiness creates the workspace and connects the official MCP server to a stdio transport. `cua-mcp` is not a required startup entry: the launcher reports an inactive row on stderr instead of stopping the profile.

[`server.ts`](src/server.ts) serves the three tools through the protocol server's low-level `tools/list` and `tools/call` handlers: the listing projects the Agent's `cua_run_code` registration, checked against the protocol's tool type, between the two tools that file defines. The connection's Agent mounts the registry's default preset and records the workspace as its working directory, which the sandbox policy resolves as the `workspace-write` root of its programs. `cua_get_api_reference` reads the provider's prompt section for that Agent through `ctx.systemPrompt.assemble` and keeps no state. A `cua_run_code` call runs through `ctx.tools.execute` inside `ctx.agents.withInitiator` with the Agent and the request signal and no model step, so the Session log carries nested `tool/ptc-dispatch` events but no root `tool/call`; [`projection.ts`](src/projection.ts) renders the result and its deferred screenshot contexts, reading each image through `ctx.cuaPrograms.screenshotRequestTarget`. `cua_reset` cancels the Agent's running program with `agent.cancel`, calls `ctx.cuaPrograms.release`, with which the provider's program runtime releases the environment of that state owner, and answers once the Agent is idle; one release runs at a time, and program calls wait for it because the runtime rejects a program while the previous process is exiting. [`consent.ts`](src/consent.ts) is the `user-questions/request` answerer for that Agent. A `cua_run_code` call runs as the Agent's maintenance activity, so an Agent disposed while a call is in flight cancels the call and waits for it and its nested calls to settle before it releases its native connection and closes its Session.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Shared CUA package](../cua/README.md) — the object API, consent rules, and `cua_run_code`.
- [macOS provider](../cua-macos/README.md) — helper preparation, permissions, and platform guidance.
- [Windows provider](../cua-windows/README.md) — helper setup, interaction rules, and platform limits.
- [Computer use](../../../docs/subsystems/computer-use.md) and [MCP](../../../docs/subsystems/mcp.md) — subsystem references.
- [Profile composition](../../boot/app-boot/README.md) — bundle layers and patch lifetimes.
- [Decision record](../../../.agents/notes/implemented/architecture/2026-11-09-computer-use-mcp-server.md) — why the server runs inside a profile and owns one Agent per connection.

-----

<a id="model-experience"></a>
## Model Experience

### External harness model

#### What the model sees

The connected harness's model sees `cua_get_api_reference`, the Agent's `cua_run_code` definition, `cua_reset`, and the server instructions from `tools/list` and `initialize`. The `cua` API reference the provider registered enters its context as the result of a `cua_get_api_reference` call, which the instructions request at the start of every conversation; `cua_run_code` results carry only program output and inspected screenshots. No DSH model request exists in this profile.

#### Token effect

The tool description carries the registration's execution rules, about 3,200 characters; a `cua_get_api_reference` result is the API reference, about 13,000 characters with the current macOS provider, about 3,300 tokens by the repository's four-character estimate, spent once per call. Screenshots are inline images at the provider's `screenshotTarget` size. Clients cap tool output; the documented Codex configuration raises the `cua_run_code` budget to 25,000 tokens. Clients also cap tool descriptions and server instructions: Claude Code 2.1.309 forwards the first 4,096 characters of either and appends `… [truncated]`; DSH's `dsh-mcp-client` forwards a 20,000-character description intact. The registration's description and the instructions, about 500 characters, fit that budget; the reference does not and travels as a tool result.

#### KV Cache effect

The tool catalog and instructions are stable for one installation. The reference text changes only with the installed CUA packages and enters a conversation as an ordinary tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- macOS and native Windows Hosts have a provider. Other Hosts, WSL included, list `cua_get_api_reference` and `cua_reset`, which both name the missing provider; a `cua_run_code` call fails as `unknown tool`.
- On Windows the [provider's limits](../cua-windows/README.md#known-limitations-and-deferred-work) apply through MCP: it does not launch applications, grants no `Always allow`, and an npm installation needs `helperPath`.
- Elicitation uses the 2025 MCP request model; a client that negotiates the 2026-07-28 revision receives an error for consent requests and should use `DSH_CUA_CONSENT=allow`.
- Program sandbox escalation and the raw `cua` tool are not exposed; `DSH_PERMISSION_MODE` selects the launch-time file sandbox of program processes, and the workspace is its `workspace-write` root.
- The `cua` API reference reaches a model only when it calls `cua_get_api_reference`. The server cannot observe a new conversation on an existing connection or a compacted context, so the instructions and the tool description carry that request; a client that withholds the tool leaves its model with the execution rules alone.
- The server does not bound result text. A program that inspects a large value returns all of it, up to the program runtime's 64 MiB output limit, and only the client's own output limit protects its context.
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
