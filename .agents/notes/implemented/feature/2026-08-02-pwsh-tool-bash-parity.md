# Agent Note: pwsh tool bash parity

Status: implemented

English | [中文](2026-08-02-pwsh-tool-bash-parity.zh.md)

## Problem

The first Windows-native foundation shipped `dsh-tool-pwsh` as a deliberately minimal profile — foreground only (a fresh process per call; no persistent PTY session), no managed-environment parity beyond three hardcoded `DSH_*` keys, and a marker story ("always `[exit code: N]`") that diverged from the bash tool's rendering without being declared. The model-visible contract drifted from the implementation: the description promised spill-path reporting the renderer never performed, the README claimed exports that did not exist and rendering the tool did not do, and the tool's own tests pinned the lossy behavior. The minimal profile also left the `DSH_*` contributor seam duplicated-by-absence: plugins contributing environment facts to `ctx.shellEnv` had no effect on pwsh calls.

## Decision

`dsh-tool-pwsh` now mirrors `dsh-tool-bash` call-for-call, and its model-visible text describes exactly that behavior:

- **Rendering adopts the bash story verbatim**: stdout, a marked `[stderr]` section, truncation notices with spill paths, `(no output)` for an empty body, and exit markers only for non-zero exits — a clean exit produces no marker. The description and the `tool:pwsh` prompt section state this precisely ("Non-zero exits are reported as `[exit code: N]` markers"), deliberately not copying the bash prompt's "every result" phrasing, which its own renderer contradicts.
- **`run_in_background` is wired through the generic job runtime** exactly like the bash tool: preflight, owner registration, `job_output`/`job_kill` control, and the same outcome mapping. `pwsh-local`'s already-mirrored `start()` handle backs it.
- **The `DSH_*` environment is shared, not duplicated**: `ShellEnvRegistry` moved out of `dsh-tool-bash` into a new tool-independent `@deepseek-ai/dsh-shell-env` package (`ctx.shellEnv` + built-ins + the session-persistence contributor), and both shell tools inject it. Contributors apply to pwsh calls exactly as they do to bash calls; shared environment ownership therefore sits outside either model-facing shell tool.
- **Windows reality is pinned where bash has no analog**: every command runs under a UTF-8 output preamble so the Windows PowerShell 5.1 fallback cannot garble non-ASCII output through the UTF-8-decoding collector, and the prompts teach that Windows forced termination settles as exit 1 without a signal marker.
- **Out of scope, unchanged**: persistent PTY shells (backends are Linux/macOS-only; ConPTY is roadmap work). Sandbox escalation shipped later with the [Windows ACL sandbox decision](2026-08-08-windows-acl-restricted-token-sandbox.md) — the pwsh tool now carries the sandbox denial rendering and the same-turn `sandbox_permissions` escalation surface, plus the Windows ConstrainedLanguage contract in its description. The pwsh-specific terminal card with an exit pill shipped separately in the [pwsh UI presentation matches bash](../../archived/feature/2026-08-05-pwsh-ui-bash-parity.md) decision.

## Alternatives considered

**Keep the minimal profile and fix only the claims.** Rejected: text contracts copied from bash drift without the corresponding implementation; a minimal tool plus accurate claims still leaves pwsh calls without background execution, without contributor parity, and with a divergent marker story that must be re-justified forever.

**Reject a mismatched executor dialect at load.** Attempted and reverted before merge: a `ShellDialect` marker (`bash` | `powershell`) on `ShellExecutor`, with both shell tools throwing when the mounted executor speaks another shell. It forced every executor implementation — including each test and example fake — to declare a dialect, adding noise to every shell-tool test for a guard with no in-repo or plausible deployment to catch (shipped compositions always pair tool-pwsh with `dsh-pwsh-local` and tool-bash with `dsh-bash-local`). The pairing contract stays documented in each tool's README instead.

**Extract a fully shared tool implementation base (abstract shell dialect, two thin leaves).** Considered and deferred: the shell-env extraction and the structural mirror (`render.ts`/`background.ts` twins) are the foundation it would rest on; a full base waits until a third dialect or the persistent-PTY twin makes the abstraction's shape observable.

## Consequences

- The bash and pwsh tools are behaviorally interchangeable for foreground, background, and sandboxed shell work (the sandbox surface is owned by the Windows ACL sandbox decision), and renderer coverage pins every pwsh prompt and description sentence.
- Parity ran BOTH ways once: the pwsh tool's structured foreground abort (`HarnessError('tool call aborted', TOOL_ABORTED)` with name `AbortError`) was backported to the bash tool, replacing its uncoded `Error('command aborted')` — a model-visible/logged change pinned by exact-shape tests on both sides and by the cancel-tool-calls fixture.
- `@deepseek-ai/dsh-shell-env` is a new shipped package; `dsh-tool-bash`'s `dshHome` config moved there, so compositions mounting the shell tools must also mount `shell-env` (the spine bundles do).
- Windows-only semantics (CRLF normalization, forced-termination exit-1/signal-null, POSIX-only self-signal) remain pinned by tests as before.
- The pwsh tool's per-file coverage gate rides on the scriptable fake-executor suite (`tests/tools.spec.ts`); the real-pwsh integration and Loader-composition suites self-skip where `pwsh` is absent, mirroring the bash suites' division of labor.
- The roadmap proposal's parity stage is delivered; the terminal-card presentation stage shipped in the [pwsh UI presentation matches bash](../../archived/feature/2026-08-05-pwsh-ui-bash-parity.md) decision (the TUI itself was removed), leaving the Windows default composition as the remaining stage.
