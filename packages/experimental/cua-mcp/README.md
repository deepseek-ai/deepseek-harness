---
description: "Serve Computer Use to Codex, Claude Code, and other MCP clients from the cua-mcp profile over stdio."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-mcp

English | [中文](README.zh.md)

## Summary

This experimental bundle turns a `dsh` profile into an MCP stdio server for Computer Use. Every DSH installation ships it switched off; one command selects it for the `cua-mcp` profile, and `dsh --profile cua-mcp` then serves `cua_run_code` and `cua_reset` to one MCP client. One connection owns one Agent whose programs keep application and window objects in memory between calls. Consent for application and pointer access is granted without a human or forwarded to the client as an elicitation. The profile runs no model turn; the connected harness owns the model.

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

### Install into a profile

The bundle is a runtime dependency of the `dsh` installation, so selecting it needs neither pnpm nor network access:

```sh
dsh plugin --profile cua-mcp enable @deepseek-ai/dsh-cua-mcp
dsh plugin --profile cua-mcp disable @deepseek-ai/dsh-cua-mcp
```

`enable` initializes the profile from `@deepseek-ai/dsh-base` when it is missing and appends this bundle to `dsh.profile.bundles`; `disable` removes the selection. A source checkout runs the same commands through `pnpm dsh` after `pnpm run build`. The Python runtime wheel ships the same installation, so a training harness writes the profile manifest itself, or runs `enable` through the wheel's executable, and then uses that executable as the stdio command:

```python
import json, os
from pathlib import Path
from deepseek_harness_runtime import resolve_bundled_launch_args

home = Path(os.environ["DSH_HOME"])
profile = home / "profiles" / "cua-mcp"
profile.mkdir(parents=True, exist_ok=True)
(profile / "package.json").write_text(json.dumps({
    "name": "dsh-profile-cua-mcp", "private": True, "dependencies": {},
    "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-cua-mcp"]}},
}))
command = [*resolve_bundled_launch_args(), "--profile", "cua-mcp"]  # the MCP stdio command
```

### Connect a client

`dsh --profile cua-mcp` is the stdio command. It prints its own help with `--help`, and `--print-client-config codex|claude-code|json` prints a ready configuration for this installation and Harness home: a `~/.codex/config.toml` fragment, a `claude mcp add-json dsh_cua` command, or a generic `mcpServers` document. Each embeds the absolute executable, `DSH_HOME`, and the current `DSH_CUA_CONSENT`. The Codex fragment sets `startup_timeout_sec = 120` for first-run helper preparation, `tool_timeout_sec = 600` to match the default program maximum, exposes both tools directly instead of through tool search, and raises the `cua_run_code` output budget to 25,000 tokens. Codex forwards elicitations only with `approval_policy.granular.mcp_elicitations = true`. DSH's own `dsh-mcp-client` declares no elicitation capability, and Claude Code 2.1 print mode declines elicitations, so unattended runs through those clients need `DSH_CUA_CONSENT=allow`.

```sh
dsh --profile cua-mcp --print-client-config codex >> ~/.codex/config.toml
dsh --profile cua-mcp --print-client-config claude-code | sh
```

On macOS the profile prepares the signed Computer Use helper on first start and needs Accessibility and Screen Recording permissions for it; the [macOS provider](../cua-macos/README.md) owns that setup. This profile has no permission page, so grant both in System Settings → Privacy & Security by adding the helper application: a source checkout prepares `DSH Computer Use Dev.app` under `packages/experimental/cua-macos/native/.build/prepared/<arch>/<build>/`, where `current.json` names the selected build; an installed package ships `DSH Computer Use.app`. Until both are granted, `await cua.getCapabilities()` reports the missing flags and application operations fail; a locked desktop fails them with `SESSION_LOCKED`. On other Hosts the profile starts without a provider, and both tools return an error naming the missing provider.

### What you get

`cua_run_code` runs a TypeScript program as REPL statements against the global `cua` object through the provider's retained Node environment. The result carries the program's printed lines and final expression as text, then every screenshot the program captured as an inline image in the exact version the program observed, so pixel coordinates in the text match the image. The first result of a connection starts with the complete `cua_run_code` execution rules and the `cua` API reference; the tool description stays short. `description` is optional and defaults to `CUA program`; `timeoutMs` bounds one program. Programs run one at a time per connection in arrival order; a cancelled call cancels its program.

`cua_reset` discards the program environment: variables, imports, and application or window objects. Application grants, native connections, and the applications themselves stay; the next program starts a fresh process and its result repeats the API reference. Use it after a conflicting declaration or an unusable environment.

The connection's Agent is created when the client finishes initialization and disposed when the client closes stdin, which also exits the process. Application consent follows the [CUA consent rules](../cua/README.md) for that Agent: `DSH_CUA_CONSENT=allow` grants each request for the session without a human, and the default `elicit` forwards the request to the client as a form elicitation whose answers are the CUA labels; a declined form records a denial for the session, and a client without elicitation receives an error that names the `allow` mode.

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

The [patch](cordis.patch.yml) disables the title, HMR, credential, authorization, and account rows of `dsh-base`, inserts the preset registry with the empty default preset, the `computer-use` registry, the macOS provider row disabled off Darwin, and this frontend. The frontend parses the invocation with `parseCmdline`, binds stdin EOF to the launcher's bounded shutdown, and connects the official MCP server to a stdio transport after the launcher commits readiness. `cua-mcp` is a required startup entry, so a frontend that cannot activate stops the profile.

[`server.ts`](src/server.ts) registers both tools on one `McpServer`. The connection's Agent mounts the registry's default preset and records the launch directory. `cua_run_code` runs through `ctx.tools.execute` with the Agent and the request signal and no model step, so the Session log carries nested `tool/ptc-dispatch` events but no root `tool/call`; [`projection.ts`](src/projection.ts) renders the result and its deferred screenshot contexts, reading each image through `ctx.cuaPrograms.screenshotRequestTarget`. `cua_reset` calls `ctx.cuaPrograms.reset`. [`consent.ts`](src/consent.ts) is the `user-questions/request` answerer for that Agent; [`client-config.ts`](src/client-config.ts) renders the client snippets.

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

The connected harness's model sees two tools and the server instructions from `tools/list` and `initialize`. The first `cua_run_code` result of a connection, and the first after `cua_reset`, begins with the `cua_run_code` execution rules and the `cua` API reference the provider registered; later results carry only program output and captured screenshots. No DSH model request exists in this profile.

#### Token effect

The first result adds about 15,000 characters once per connection or reset with the current macOS provider: 2,200 characters of execution rules and 12,800 of API reference, about 3,800 tokens by the repository's four-character estimate. Screenshots are inline images at the provider's `screenshotTarget` size. Clients cap tool output; the generated Codex configuration raises the `cua_run_code` budget to 25,000 tokens.

#### KV Cache effect

The tool catalog and instructions are stable for one installation. The first result's reference text changes only with the installed CUA packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only macOS Hosts have a provider; the Windows provider mounts here once it exists. Other Hosts serve both tools as errors.
- Elicitation uses the 2025 MCP request model; a client that negotiates the 2026-07-28 revision receives an error for consent requests and should use `DSH_CUA_CONSENT=allow`.
- Program sandbox escalation and the raw `cua` tool are not exposed; `DSH_PERMISSION_MODE` selects the launch-time file sandbox of program processes.
- Root tool calls are not Session events; the connected harness's transcript is the record of calls and results.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
