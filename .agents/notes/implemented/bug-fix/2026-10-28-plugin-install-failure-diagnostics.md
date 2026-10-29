# Agent Note: Install failures keep their diagnostics in the dialog

Status: implemented

English | [中文](2026-10-28-plugin-install-failure-diagnostics.zh.md)

## Problem

A failed plugin installation could show the generic sentence "Something went wrong during the install; the details say what" while its expanded details showed only "No output". The dialog rendered the live install-log stream and the failure kind, and the two Host diagnostics that explain such a failure never entered that stream. A pnpm run that printed nothing had its diagnostic (`result.shortMessage`, or `pnpm failed` as the fallback) written to the complete log and the returned result but never streamed, so the dialog's terminal stayed empty. The GitHub connection check that stops an installation before pnpm runs kept its captured output only in `packageResult.output`. The Client also ignored the settled result's `packageResult.logPath` and `stage`, so a failure with recorded diagnostics offered no path to the complete log and could not say that a finished installation failed while the bundle was being activated.

## Decision

**The install-log stream carries the Host diagnostic of every run the dialog shows.** A pnpm run that fails without printing anything streams the diagnostic the Host records for it, so the complete log and the dialog show the same text. The GitHub connection check reports the `git … ls-remote` command line it ran, with the user information of an http(s) repository URL removed; when its network failure or timeout stops the installation, `installBundle` emits that command, the captured output, and the failure's exit status as the installation's only install-log run under the caller's request id. A check failure the installation survives streams nothing. A timed-out check's Git returned no exit status, so that run settles without one; the returned result records the coerced status 1, because `PackageResult.exitCode` is a number, and `PackageResult.timedOut` states that the status is the one the failure is read as. The command line itself stays module-local: `installBundle` strips it off the plain `PackageResult` it returns, so no second wire field appears.

**The failed screen keeps what the settled result reports, not only the live stream.** `InstallState` holds the settled `packageResult.logPath` — the run that settled the dialog, on the Host's filesystem — and the details name it as the complete log. `InstallState['failure'].stage` and `ChangeResult.enabled` add the sentence that the installation finished and enabling the bundle failed, only when that change did ask to enable it; an install that left activation to **Enable now** never claims it failed enabling. Details on a settled screen without a streamed run say the dialog received no terminal output, never that the run printed none, and a running install makes no such claim. The generic sentence names the failed install command, except when the failed step is applying an enabled bundle, where the enabling sentence stands alone. The answer and the log travel over separate transports, so a run whose first chunk arrives after the answer is kept in the settled dialog as a settled run rather than dropped or shown as running.

No wire type, public export, or config key is added: `ChangeResult.packageResult.logPath`, `ChangeResult.stage`, `ChangeResult.enabled`, and `packageResult.timedOut` already carry these facts to every consumer. The check's command line is a module-local `GithubConnectionFailure` in `github-connection.ts`.

## Alternatives considered

**Have the Client synthesize a terminal run from `packageResult.output`.** Rejected: the install-log stream would stay incomplete for every other reader, including the agent tool and the complete Host log, and the dialog would carry two notions of a run — one streamed, one rebuilt from the result.

**Render `packageResult.output` as a separate Host-diagnostic block.** Rejected: it duplicates the terminal surface with a second styling and copy path, and the failing check's command line would still be missing.

**Add a failure-stage field to `ChangeResult`.** Rejected: `stage` already names installation and activation, and only activation needed its own sentence; a second stage vocabulary would make every consumer learn two fields for one fact.

**Keep the generic sentence and rely on the details.** Rejected: the empty details panel this fixes was exactly what the sentence pointed at, so the sentence must not promise diagnostics the dialog does not show.

**Report the check's coerced exit code in the streamed run too.** Rejected: the stream describes what the process did, and a Git the deadline killed returned no status; the result keeps the coerced status only because its exit code is a number, which the JSDoc states.

## Consequences

- A failed installation always offers something to act on: a pnpm diagnostic for a silent failure, the failing Git command and its output for a GitHub connection failure, the complete log of the settled run, and a sentence naming the failed step when an enabled installation could not be applied.
- The generic sentence becomes "The install command failed; the details say why" in every dictionary; the details' no-run note says the dialog received no terminal output.
- A GitHub connection failure reports `timedOut` and returns the coerced exit status 1, while its streamed run settles without an exit code; the displayed command line omits URL user information, and no `argv` field joins the Remote answer.
- The details' log path covers the run that settled the dialog and is a Host path, so earlier registry attempts and a remote browser may not reach it.
- No new configuration, wire field, or public package export.

## Related

[Guided plugin installation](../architecture/2026-09-15-guided-plugin-installation.md) owns the install dialog's screens, the pre-install spec check, and the failure classification; this note extends its failed screen and install-log stream.

## Testing

- `packages/boot/plugin-manager/tests/operations.spec.ts` pins the no-output diagnostic stream; `github-connection.spec.ts` pins the recorded command line without URL user information and the timeout state, including the coerced status in the result; `manager.spec.ts` pins the single streamed check run under the request id, its absent exit code on timeout, that the returned `packageResult` carries no command line, and that a check failure pnpm may resolve streams nothing.
- `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` pins the settled log path, stage and enablement fact, the run kept when its first chunk arrives after the answer, and the reset on retry; `components.client.spec.tsx` pins the enabling sentence (only for an install that asked to enable), the complete-log line, and the settled no-output sentence.
- `apps/web/tests/plugin-install-github.e2e.ts` expands the details of a real GitHub connection failure and finds the Git command, its output, and the log path; `apps/web/tests/plugin-install-silent-failure.e2e.ts` fails a real installation through a package manager that prints nothing and finds the run's command line, its diagnostic, and the complete log in the details.
