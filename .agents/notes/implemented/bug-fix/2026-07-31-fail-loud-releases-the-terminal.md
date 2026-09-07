# Agent Note: fail-loud releases the terminal before exiting

Status: implemented

English | [中文](2026-07-31-fail-loud-releases-the-terminal.zh.md)

## Problem

A `dsh` launch whose config failed validation printed its diagnostic and returned the user to a broken shell. Typing was invisible, and the next command was mangled by stray text:

```
dsh: fatal load failure: ValidationError: invalid config:
  - $.providers expected object but got [object Object] (at providers)
$ 1;2;4cecho hello
zsh: command not found: 4cecho
```

The Loader mounts entries concurrently, so entry failure order is not startup order. `ui-tui` activates and calls pi-tui's `ProcessTerminal.start()`, which puts stdin in raw mode, enables bracketed paste, and writes the Kitty keyboard-protocol probe — a sequence ending in a Device Attributes query (`ESC [ c`). A sibling entry (here `llm-pi-ai`) then rejects on its own config. At the time, that rejection surfaced as an unhandled rejection, and `installFailLoud` wrote one stderr line and called `process.exit(1)` immediately. (The transactional Loader now settles config-tree failures through `boot()`, which disposes the partial context itself; the release hook remains the guard for rejections `boot()` cannot see — a plugin's detached async work rejecting during or after mounting.)

Nothing disposed the tree, so `ProcessTerminal.stop()` never ran: raw mode, bracketed paste, and the keyboard protocol stayed set on the shell that outlived the process. The terminal's answer to the Device Attributes query (`1;2;4c`) arrived after exit and was read by the shell as typed input — the literal text above.

The `/exit` path was never affected, because it disposes the tree and reaches the TUI's own `shutdown()`, which calls `drainInput()` (absorbing the pending reply) and then `ui.stop()`. The defect was that a *failed boot* had no path to that same teardown.

## Decision

`installFailLoud` takes an optional `release` teardown, awaited between the diagnostic and the exit:

- The diagnostic is written **before** the release, so a hanging or failing disposer cannot swallow the reason.
- A latch, not an uninstall, keeps the first rejection the reported one. Removing the listener during teardown would let a second concurrent rejection become uncaught, and Node would kill the process mid-teardown — stranding exactly the terminal state this restores. Later rejections, including the release's own, fall through to the pending exit.
- The release is bounded by `FAIL_LOUD_RELEASE_TIMEOUT_MS` (2s) and its rejection is swallowed. A wedged or failing disposer delays the fatal exit; it never cancels it. That timer stays **referenced**: an `unref()`ed one lets Node reach an empty event loop and exit 0 on the very failure being reported, because an `unhandledRejection` listener suppresses the default fatal exit.
- Omitting `release` keeps the previous behavior exactly, so the ACP, JSON-RPC, and demo bins are unchanged.

`dsh`'s TUI launcher passes a release that disposes the root context, which runs the TUI's existing `shutdown()` and hands the terminal back.

The launcher captures the root context in `boot()`'s `prepare` hook rather than from its return value. The rejection arrives while `boot()` is still in flight, so `app.current` assigned after the `await` would still be `undefined` at exactly the moment the hook needs it. `prepare` runs after the Loader installs and before any config-tree entry mounts, which covers the whole window in which an entry can reject.

## Alternatives considered

**Reset the terminal from the fail-loud handler** (write `ESC [ ? 2004 l`, pop the keyboard protocol, clear raw mode). This duplicates pi-tui's teardown in a package that owns no terminal, and would drift as pi-tui's startup sequence changes. It also cannot absorb the in-flight Device Attributes reply, which is what corrupts the next prompt — only draining stdin while it is still raw does that.

**Register a `process.on('exit')` terminal reset in the TUI.** Exit handlers are synchronous, so they cannot await `drainInput()`; the stray reply would still land. It also puts teardown on a global hook rather than the disposal path that already exists.

**Have the TUI refuse to start until the tree settles.** This serializes a deliberately concurrent Loader and delays first paint for every healthy launch to fix a failure path.

**Reorder config entries so `llm-pi-ai` mounts before `ui-tui`.** Ordering is not a guarantee the Loader makes, and any future entry could fail after the TUI mounts.

## Consequences

A failed boot now costs one tree disposal (bounded at 2s) before exit, and the exit code stays 1. In exchange, a misconfigured `dsh` returns a usable shell instead of one needing `stty sane` or `reset`.

The guarantee belongs to whichever bin owns the terminal: a surface that grabs terminal state and does not pass `release` reintroduces this defect. `installFailLoud` cannot detect that on its own, since it has no view of what a mounted plugin did to the process.

## Testing

`packages/boot/app-boot/tests/app-boot.spec.ts` covers the release contract: the hook is awaited before the exit commits, a rejecting hook still exits 1, a never-settling hook exits after `FAIL_LOUD_RELEASE_TIMEOUT_MS`, and a burst of rejections reports only the first while the release still completes.

Those fake-process tests cannot observe the two failure modes that matter most — process exit code with a real event loop, and terminal state after exit — so the regression lives in `apps/cli/tests/tui-keyless-smoke.e2e.ts`. It boots the shipped tree in a real PTY over `fixtures/tui-invalid-provider.cordis.yml` (a list-shaped `providers`, the mistake users actually make), expects exit 1, and asserts the captured bytes contain both the labelled boot rejection (`dsh: plugin tree failed to load:`) and `ESC[?2004l`. The same case pins the boot path end to end: it caught the [HMR initial-scan boot deadlock](../../archived/bug-fix/2026-08-03-hmr-initial-scan-boot-deadlock.md) that silently exited 13 with the terminal stranded.

The `/exit` path keeps its existing assertion that the same reset appears on a clean exit.
