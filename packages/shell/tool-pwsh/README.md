---
description: "The model-facing pwsh tool for users and maintainers choosing, configuring, or debugging one-shot PowerShell execution, background jobs, and sandbox escalation on Windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-pwsh

English | [中文](README.zh.md)

## Summary

`dsh-tool-pwsh` gives the agent a `pwsh` tool that runs PowerShell commands through the mounted shell executor — the Windows counterpart of `dsh-tool-bash`, mirroring it call-for-call. Each call runs in a fresh pwsh process, so no state survives; `run_in_background` turns long-running commands into background jobs. Commands are PowerShell-dialect: native `C:\...` paths and `$env:NAME` variables, with no dialect translation. Every call runs with the managed `DSH_*` environment, and under a sandboxing executor the tool teaches and enforces the Windows-specific language-mode and named-pipe contracts. Mount it with a PowerShell executor such as `dsh-pwsh-local` and the `dsh-shell-env` plugin.

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

Load this plugin in any composition where the agent should run PowerShell commands — typically a Windows composition whose `ctx.shell` is backed by a PowerShell executor. It registers the `pwsh` tool once the executor provider and the `dsh-shell-env` registry are mounted.

### When to choose it

Choose the pwsh tool when commands must be written in PowerShell — native paths and `$env:` variables — or when the deployment is Windows-native. Choose `dsh-tool-bash` when the command set is bash-dialect; there is no translation between the two. When work needs cross-call state (cwd, variables), the persistent counterpart [`dsh-tool-pwsh-persistent`](../tool-pwsh-persistent/README.md) keeps one owner-scoped shell alive.

### Minimal configuration

The common path is a PowerShell executor provider, the environment registry, and this tool.

```yaml
- name: '@deepseek-ai/dsh-pwsh-local'
- name: '@deepseek-ai/dsh-shell-env'
- name: '@deepseek-ai/dsh-tool-pwsh'
```

The single config field toggles background support.

| Field | Default | Meaning |
|---|---|---|
| `enableRunInBackground` | `true` | Expose `run_in_background`; when `false`, forced background calls are rejected |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-pwsh) is the exhaustive source for every accepted field and its JSDoc; the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh) carries the full argument schema.

### Running a command

The tool executes `pwsh -Command <command>` and returns the combined output. Commands run in a fresh pwsh process every call, so state never persists — pass `workdir` instead of `cd`. Paths use native Windows form and environment variables are read with `$env:NAME`. A non-zero exit is reported as `[exit code: N]`; on Windows a force-killed command settles as `[exit code: 1]` without a signal marker, so the agent treats a bare exit 1 after an interruption as a termination, not a command failure. Background runs, output truncation, and the `description`/`timeoutMs`/`workdir` arguments behave exactly as in `dsh-tool-bash`.

### Windows-specific sandbox behavior

Under a sandboxing executor, denied commands report `[sandbox: file access denied under <mode> mode]`, and the same one-shot escalation path applies: retry the exact command once with `sandbox_permissions` plus a `justification` through user approval. The tool also teaches two Windows-restricted-token contracts in its description: read-only pwsh runs in ConstrainedLanguage (`.NET` static calls, `Add-Type`, COM, and reflection fail with "only core types" errors), and in both confined modes programs cannot open named pipes, so a command that captures another program's output through piped stdio fails with EPERM — escalate the exact command once or restructure it to avoid capturing output.

### What can go wrong

A composition with no PowerShell executor never activates the tool, and the injected services (`tools`, `shell`, `systemPrompt`, `shellEnv`) must all exist. Background calls without the job runtime fail with `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`, and `sandbox_permissions` without a sandboxing executor fails with `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **A deliberate twin of `dsh-tool-bash`.** Foreground and background execution, the managed environment, the sandbox escalation surface, and the marker/truncation rendering mirror the bash tool call-for-call, so consumers of one accept the other's wire shape ([pwsh tool bash parity Agent Note](../../../.agents/notes/implemented/feature/2026-08-02-pwsh-tool-bash-parity.md)).
- **PowerShell-dialect contract.** The tool contract is PowerShell: native paths and `$env:` variables, executed via `pwsh -Command` with no intermediate shell.
- **Windows sandbox facts taught in the description.** The ConstrainedLanguage and named-pipe contracts are Windows-restricted-token behavior; the gate for teaching them is "any confining executor is mounted", which is safe because every shipped pairing is win32-only.
- **Non-zero exits are reported, not errored.** Only infrastructure failures (spawn errors, aborts) surface as tool errors, matching the bash story.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, prompt section, arg validation, escalation, request assembly |
| [`src/background.ts`](src/background.ts) | Map a settled background process onto generic job outcome vocabulary |
| [`src/render.ts`](src/render.ts) | Model-facing result text: streams, markers, truncation notices (bash twin) |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Rendering and exit markers

The renderer shares the bash tool's structure and the `parseExitStatus` marker contract from `dsh-shell`: a clean exit (0, no signal) produces no marker; the UI card consumes the exit marker as its exit-status pill. Windows forced termination settles as exit 1 without a signal, so `[killed by signal: …]` is POSIX-only there. The `tool:pwsh` prompt section (first-party order 1010) teaches the exit-marker convention and the Windows exit-1-after-interruption reading.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shell family to the executor seam and the design notes behind the Windows behavior.

- [shell package map](../README.md) — the bash capability family and its roles.
- [Bash executor subsystem](../../../docs/subsystems/shell.md) — request/spec vocabulary, results, and background processes.
- [shell-env](../shell-env/README.md) — the managed `DSH_*` environment every call receives.
- [tool-jobs](../../jobs/tool-jobs/README.md) — `job_output`, `job_list`, and `job_kill` controls for background runs.
- [pwsh tool bash parity Agent Note](../../../.agents/notes/implemented/feature/2026-08-02-pwsh-tool-bash-parity.md) — why the tool mirrors the bash tool.
- [Windows ACL restricted-token sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) — the language-mode and named-pipe contracts.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh) — the exact `pwsh` argument schema.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-pwsh) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains the pwsh guidance below at first-party order 1010. Scoped tool restrictions can hide the schema without removing this independently registered section.

##### Pwsh guidance

```markdown
Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.
```

#### Token effect

Small fixed input cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the registration scope and prompt text are unchanged. Plugin activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The model sees the generated [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh). Agent-scoped tool restrictions can remove the definition for that agent.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while visibility and the tool definition are unchanged. A restriction or config change may invalidate reuse from the first changed token.

### Foreground result

#### What the model sees

The renderer emits the data-dependent stdout tail, then optional `[stderr]` and the stderr tail. Conditional lines are exactly `[output truncated; full output: <path-or-(unavailable)>]`, `[sandbox: file access denied under <mode> mode]` plus the escalation hint `[sandbox: escalation available — …]` (only when the composition advertises escalation), `[timed out after <timeoutMs>ms]`, `[killed by signal: <signal>]`, and `[exit code: <exitCode>]` (nonzero exits only); an empty body renders as `(no output)`.

#### Token effect

Zero result tokens before a call. Output is bounded per stream, while each emitted line remains in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Background result

#### What the model sees

A background start renders exactly `started background job <id>`; subsequent reads and status flow through the generic `job_output`/`job_kill` tools, including the lossy-read spill notice when in-memory truncation dropped unread bytes.

#### Token effect

The ack is a fixed short line; job output is bounded per read.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Validation and infrastructure failures are normalized as `Error: <message>`. This package's stable messages are `invalid command: expected a non-empty string`, `invalid description: expected a non-empty string`, `invalid timeoutMs: expected a positive number, got <value>`, the escalation pairing failures, `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`, the shared escalation failures (not strictly wider / no approval service / no agent to route / no approval channel / user rejected / was cancelled), `run_in_background is disabled for this deployment (enableRunInBackground: false)`, `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`, and `tool call aborted`.

#### Token effect

Only the failing call adds these retained tokens; an aborted call adds no command output.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Language mode and named-pipe capture under the Windows sandbox** — under the [Windows ACL sandbox](../../sandbox/sandbox-windows-acl/README.md), read-only pwsh starts in ConstrainedLanguage because its temp write denial makes PowerShell's AppLocker probe fail closed: `Add-Type`, non-core .NET statics (`[System.IO.*]::`, `[math]::`), COM objects, and reflection fail with "only core types" errors, and the mode cannot be lifted from inside. Workspace-write's private temp lets the probe complete, so it stays in FullLanguage unless host policy says otherwise. Both confined modes deny named-pipe opens, so a piped-stdio spawn inside a confined command fails with EPERM. The tool description teaches both contracts to the model; the backend README owns the full limitations.
- **No persistent shell** — every call starts a fresh `pwsh -Command`; the persistent-shell counterpart is [`@deepseek-ai/dsh-tool-pwsh-persistent`](../tool-pwsh-persistent/README.md), which keeps one owner-scoped pwsh alive across calls.
- **PowerShell-dialect contract** — the model must write PowerShell (native paths, `$env:` variables), not bash; there is no dialect translation.
- **Session-cwd identity is not canonicalized** — the workdir base is the session header cwd as-is, unlike the bash tool's sandbox-root-canonicalized identity. Under a confining executor the policy's workspace root IS canonicalized (by the shared policy service), so the workdir and the confinement root can diverge when the raw session cwd differs from its canonical form — a parity gap deferred to the shared shell-tool base extraction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
