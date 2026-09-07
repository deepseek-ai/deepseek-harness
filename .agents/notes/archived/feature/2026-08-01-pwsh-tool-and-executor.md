# Agent Note: PowerShell executor and pwsh tool

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-01-pwsh-tool-and-executor.zh.md)

## Problem

The harness spoke one shell dialect on every platform: `bash`. Windows hosts could run it only through WSL or Git-Bash shims, and the shipped `dsh-bash-local` executor is POSIX-only (`bash` hardcoded, process-group semantics POSIX). The Windows roadmap — defaulting hosts to `pwsh`, later pwsh TUI/GUI rendering — had no execution foundation: there was no PowerShell implementation of the bash executor seam and no model-facing tool that taught the PowerShell dialect. The bash tool is also larger than a Windows-first profile strictly needs — the persistent-PTY twin in particular is bash-shaped surface the `pwsh` tool still does not carry. The original minimal profile also left out background jobs and sandbox escalation: background arrived with the [parity decision](2026-08-02-pwsh-tool-bash-parity.md), and the sandbox surface (denial rendering plus `sandbox_permissions` escalation) arrived with the [Windows ACL sandbox decision](2026-08-08-windows-acl-restricted-token-sandbox.md) — the minimal tool was sized for the danger-full-access Windows posture, and that premise ended when the sandbox PR re-enabled confinement and approval on Windows.

## Decision

Two new packages under `packages/shell/`:

- **`@deepseek-ai/dsh-pwsh-local`** — a local implementation of the `ctx.shell` executor seam over `ctx.subprocess`, mirroring `dsh-bash-local` call-for-call: `resolve()` defaults and caps from config, `run()` fuses the config-clamped timeout with the caller's signal through one deadline, `start()` returns a consuming background handle whose processes belong to the subprocess service. The command string rides as ONE argv element to `pwsh -NoLogo -NoProfile -NonInteractive -Command`, so PowerShell parses it and no shell-quoting layer exists. Executable resolution (`resolvePwshPath`) is a pure function of `(configured, env, platform)`: explicit config first, then Windows probes PowerShell 7's install, PATH entries (quotes stripped), and Windows PowerShell 5.1, else a bare `pwsh` via PATH.
- **`@deepseek-ai/dsh-tool-pwsh`** — the model-facing tool over `ctx.shell`, PowerShell-dialect by contract, mirroring `dsh-tool-bash` call-for-call: foreground and `run_in_background` execution through the generic job runtime, managed `DSH_*` environment through the shared [`dsh-shell-env`](../feature/2026-08-02-pwsh-tool-bash-parity.md) registry, the bash marker/truncation rendering story (a clean exit produces no marker), and — since the Windows ACL sandbox decision — the sandbox denial rendering and `sandbox_permissions` escalation surface, plus the Windows-specific ConstrainedLanguage and named-pipe contracts in the tool description. The parity decision supersedes this note's minimal-profile tool description.

Windows vitest coverage is deliberately NOT part of this change: the repo's Windows CI lane owns build/static gates, and unit coverage runs on Linux, where both packages' suites run against a real `pwsh` (preinstalled on the GitHub-hosted runners) or self-skip when absent. The vitest `windowsUnsupportedPackages` exclusion narrows from `packages/shell/*` to the bash-requiring packages so the pwsh suites can also run natively on Windows dev machines.

The roadmap beyond this decision — defaulting Windows hosts to `pwsh` (bash off), and pwsh TUI/GUI rendering — is recorded separately as [the Windows pwsh default decision](2026-08-01-windows-pwsh-default.md).

## Alternatives considered

**Extend `dsh-bash-local` with a pwsh mode.** Rejected: the executor's identity is the shell it spawns; a second dialect inside one package doubles its config surface (`shell` switches) and its test matrix, and the two dialects' quirks (signal facts on Windows, quoting domains) belong to their own packages' documentation.

**Extend `dsh-tool-bash` with a dialect parameter.** Rejected: the model-visible contract is the dialect itself (paths, variables, exit facts differ), so a dialect parameter would either churn the schema conditionally or force one tool to teach two dialects; the separate twin keeps the model contract honest — and carries the shared surfaces (background, sandbox, rendering) by mirroring rather than by sharing an implementation.

**Wire the pwsh tool into the shipped CLI compositions now.** Rejected: mounting `tool-pwsh` + `pwsh-local` in `base.cordis.yml` would change the shipped roster before the Windows-default decision lands; this change ships the capability and its wiring points (`apps/cli` dependencies, tsconfig projects) without switching any default.

## Consequences

- The bash executor seam gains a second, Windows-native implementation with an identical request/spec contract, so model-facing consumers beyond `tool-pwsh` (hooks bridges, in-process plugins) can run PowerShell without dialect shims.
- `tool-pwsh` is the model-visible Windows-first shell tool: behaviorally interchangeable with the bash tool for foreground, background, and sandboxed work — including the same-turn `sandbox_permissions` escalation through `ctx.approval` — with prompt guidance that states the marker contract, the sandbox denial/escalation vocabulary, and the ConstrainedLanguage and named-pipe boundaries precisely.
- Windows semantics differ where the platform differs: forced termination reports exit 1 with no signal (so `signal`/`killed` status facts are POSIX-only), and PowerShell writes CRLF, which tests normalize.
- The CLI gains two workspace dependencies and two tsconfig projects without mounting either plugin — the composition decision stays with the Windows-default proposal.
