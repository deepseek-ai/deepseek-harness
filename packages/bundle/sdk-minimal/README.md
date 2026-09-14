---
description: "Standalone SDK profile with one default shell tool for users who need a minimal cross-platform coding agent without the shared base bundle."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-minimal`

English | [中文](README.zh.md)

## Summary

Use `dsh --profile sdk-minimal` when an SDK client needs a small, explicit coding-agent runtime. By default, the profile advertises only a platform-selected persistent shell, persists sessions as uncompressed JSONL, and selects the model from the SDK initialization request. It supplies a complete Cordis tree and deliberately excludes `dsh-base`, Web, settings, managed credentials, telemetry, compaction, filesystem tools, workspace instructions, skills, jobs, and subagents. Its danger-full-access policy lets the shell modify any path available to the process, so use it only with an isolated workspace.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Launch the profile directly or select it from the Python SDK. Supply an explicit `DSH_HOME`, use a disposable workspace, and provide the model credential through `DEEPSEEK_API_KEY`.

```sh
export DSH_HOME=/absolute/path/to/example-dsh-home
dsh --profile sdk-minimal
```

`DSH_CONTEXT_WINDOW` sets the fallback capacity for a model absent from the adapter's advisory catalog. `DSH_SYSTEM_PROMPT` replaces the default persona. The SDK initialization request is the sole model selection and overrides environment defaults.

Use `dsh plugin --profile sdk-minimal` to manage persistent external dependencies. Profile, home, and ordered `--patch` files can replace rows or insert bundles above the complete default tree. The shipped template applies patches only at startup.

The profile mounts exactly one persistent shell stack: Bash on Linux and macOS, or PowerShell on Windows. Both stacks use a 300-second timeout and one owner-scoped terminal; the other platform's rows remain disabled.

Like every shipped profile, it mounts [MCP resources](../../mcp/mcp-resources/README.md) once. Configure only [MCP client entries](../../mcp/mcp-client/README.md) to add servers. Clients mounted by another provider also count as configured. With no server configured in the caller's scope, MCP contributes no prompt text or tools and the default remains one shell tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle's single insert is the complete application tree: SDK stdio startup and JSON-RPC serving, one environment-configured DeepSeek adapter, the explicit agent core, conditional MCP resource tools, local subprocess execution, a platform-selected persistent shell PTY, and uncompressed JSONL persistence under `$DSH_HOME/sessions`. It does not inherit another bundle, so every extra row is an explicit profile change.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Complete standalone profile tree and its environment-backed defaults |
| [`src/index.ts`](src/index.ts) | Bundle package entry |
| — | No runtime invariant companion is published; the package is a static patch-list carrier whose inserted rows own their runtime relationships and invariant companions. |
| [`tests/sdk-minimal.spec.ts`](tests/sdk-minimal.spec.ts) | Exact composition, profile-name, and platform-selection checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Python SDK example](../../../python/sdk/examples/README.md) — launches this profile from Python against an explicit Harness home.
- [SDK application bundle](../sdk-app/README.md) — the JSON-RPC application layer reused by full and minimal SDK profiles.
- [Base bundle](../base/README.md) — the full product foundation that this profile deliberately omits.

-----

<a id="model-experience"></a>
## Model Experience

### Minimal coding-agent composition

#### What the model sees

The system prompt is `DSH_SYSTEM_PROMPT` or `You are a helpful software engineer assistant.`. With no MCP server configured, the only advertised tool is owner-scoped persistent `bash` on Linux/macOS or `pwsh` on Windows; runtime context, filesystem tools, workspace instructions, skills, jobs controls, compaction, and Harness identity are absent.

#### Token effect

By default, one stable persona plus one tool schema. Configured MCP servers add their tools, shared resource tools, and available server instructions. Tool results and ordinary conversation history grow with the session.

#### KV Cache effect

Stable for a fixed persona, platform, provider, model, and bundle patch stack. Profile changes take effect on the next process.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The composition intentionally omits shared product services** — select `dsh --profile sdk` when settings, managed credentials, policy presets, telemetry, Web tools, or the full default tool roster are required.
- **User patches can expand the tree and corrupt stdout** — profile customization is trusted application composition; a plugin that writes ordinary text to stdout can break JSON-RPC framing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
