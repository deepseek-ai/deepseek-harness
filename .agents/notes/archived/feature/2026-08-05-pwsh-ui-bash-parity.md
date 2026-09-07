# Agent Note: pwsh UI presentation matches bash

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-pwsh-ui-bash-parity.zh.md)

## Problem

The [pwsh tool bash parity decision](../../implemented/feature/2026-08-02-pwsh-tool-bash-parity.md) made `dsh-tool-pwsh` behaviorally interchangeable with `dsh-tool-bash` for execution, markers, and background jobs, but explicitly deferred the human-visible half: a completed pwsh foreground call presented as a generic `console`-fenced card while the bash tool's completed call presented as a terminal card with a parsed exit-status pill. The roadmap that owned this gap ([Windows defaults to pwsh](../../implemented/feature/2026-08-01-windows-pwsh-default.md)) named "pwsh TUI/GUI rendering" as stage 2, but the TUI package was removed, leaving the Web surface as the only UI the gap affects.

## Decision

`dsh-tool-pwsh`'s `presentResult` now mirrors `dsh-tool-bash`'s call-for-call: a completed foreground result is a `terminal` card whose output body is the marker-free rendered text and whose exit-status pill is the parsed `exitCode`/`signal`; background acknowledgements and `isError` results stay generic `console`-fenced cards; non-single-text-block results stay untouched (`undefined`).

The parse is shared, not duplicated: `parseExitStatus`/`ParsedExitStatus` moved from `dsh-tool-bash`'s private render module into the `@deepseek-ai/dsh-shell` Service Definition package (exported from its index), and `dsh-tool-bash`'s `render.ts` re-exports it so its source-plane consumers keep one import root. Both tools' renderers emit the same `[exit code: N]` / `[killed by signal: X]` markers, so one Service-Definition-owned inverse can never drift between the twins — the same "shared, not duplicated" shape the [shell-env extraction](../../implemented/feature/2026-08-02-pwsh-tool-bash-parity.md) used for the `DSH_*` registry.

The Web UI needs no per-tool code for the card itself: the client's terminal-card bridge maps any `card: 'terminal'` result view (`terminal-card-model` in `dsh-client-ui-conversation`), so the pwsh presenter change flows through the same rendering path bash already has. The collapsed tool row does get one client classification entry: `classifyTool('pwsh')` now yields the shell-family row (`bash` variant, its own `Pwsh` title) instead of the generic `others` "Tool call" row. A keyless browser lane (`apps/web/tests/pwsh-terminal.e2e.ts`) seeds a session whose pwsh call/result is presented by the real tool on replay — the api-proxy recomputes views from logged args/result content — and pins the terminal card golden, including the exit pill and the run-state dot.

## Alternatives considered

**Import `parseExitStatus` from `@deepseek-ai/dsh-tool-bash/src/render.ts`.** Rejected: workspace imports stay external in the built bundles, so `tool-pwsh` would gain a hard runtime dependency on `tool-bash` in every consumer closure (including compositions that deliberately mount the pwsh twin without bash), and a sibling tool depending on its twin for one function inverts the package relationship. The seam move keeps the shared contract on a package both tools already depend on.

**A new dedicated presentation package (e.g. `@deepseek-ai/dsh-shell-present`).** Rejected: a new package costs manifests, module-graph/catalog regeneration, and README surface for a single pure function; `@deepseek-ai/dsh-shell` is already in both tools' closures and already owns the `ShellRunResult` facts the parse reconstructs.

**Duplicate the parse into `tool-pwsh`'s render module (a third twin).** Rejected: copied text contracts drift without a shared implementation ([pwsh tool bash parity](2026-08-02-pwsh-tool-bash-parity.md)); the parse and the marker emission must co-evolve in one place, and the parse is exactly the contract the UI pill depends on.

## Consequences

- A Windows composition using `dsh-tool-pwsh` now shows its shell calls exactly as bash calls look in the Web UI: cwd-headed terminal card, raw output, exit-status pill, run-state dot, and the red failure treatment on non-zero exits.
- `parseExitStatus` becomes public contract surface on `@deepseek-ai/dsh-shell`; `dsh-tool-bash/src/render.ts` keeps re-exporting it, so no bash-tool consumer changes.
- The roadmap's stage 2 shrinks: the TUI is removed (EOL), and the terminal-card counterpart now ships on the Web surface. The Windows default composition (stage 1) remains the outstanding stage.
- Verification: `dsh-shell` owns the parse edge cases under the per-file coverage gate; `tool-pwsh`'s presenter suite mirrors `tool-bash`'s (clean/non-zero/signal/timeout round-trip, marker-like output, background/error generics, multi-block fallback); the client row-model suite pins the `Pwsh` shell-family row; the web `pwsh-terminal` lane is the assembled keyless scenario.
