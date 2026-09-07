# Agent Note: tmux-location context

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-27-tmux-location-context.zh.md)

## Problem

An agent running inside tmux has no way to tell the model where it is: which session, window, and pane the process occupies, and how the window is laid out. A user directing several panes wants the model to orient itself to its own location so instructions like "the pane below" or "this window" resolve. The location must reach the model as durable, reconstructable context, not a system-prompt value rewritten in place, and must cost nothing when the location has not changed.

tmux exposes this without a daemon: `$TMUX_PANE` names the process's pane, and `tmux display-message -t "$TMUX_PANE" -p '<format>'` prints any pane/window/session field. The open question was how to observe it — pull on each preparation, or push from a tmux hook — and how to avoid a per-step token cost and hidden process-local state.

## Decision

`@deepseek-ai/dsh-tmux-context` is an opt-in function plugin in `packages/context/tmux-context/`, alongside the other bounded request-context enrichments that define neither a tool nor a service. Shipped profile trees do not mount it by default because terminal-multiplexer context is surface-specific; a composition that needs it adds its row explicitly.

**Pull on the first step of each turn, not a tmux push.** The plugin prepends an `agent/pre-step` listener and acts only when `step === 1`. A pull model needs no background process, no hook installation in the user's tmux, and no teardown; it re-reads current state each turn so a moved, renamed, or re-laid-out pane is picked up naturally. Gating on the first step makes the reading per-turn: a location is stable within a turn, and re-querying every step would add cost without new information. A pane moved mid-turn is reflected on the next turn, which is the accepted tradeoff for the simpler design.

**Read through the `ctx.shell` seam, never raw `child_process`.** The listener runs the tmux/`ps` read commands through `ctx.shell`, so the deployment's sandbox and policy apply and the plugin owns no subprocess code. Absent `ctx.shell`, absent tmux env, a wrong field count, or an empty pane id each make the attempt a no-op, matching how `agent-instructions` no-ops without an `fs` provider.

**Detect a real pane by tty, not by `$TMUX_PANE` alone.** `$TMUX_PANE` is inherited: a terminal launched from a tmux shell (a VS Code integrated terminal, a desktop launcher) carries `$TMUX`/`$TMUX_PANE` from that ancestor even though the process does not live in that pane, which otherwise injects a stale, wrong location. The command resolves this process's controlling terminal with `ps -o tty= -p <pid>` (the agent's own pid, passed in-process) and compares it to the pane's `#{pane_tty}`; fields are emitted only on a match. A genuine pane owns this process's tty; an inherited environment names some other pane's tty and reads as "not in tmux". Checking `$TMUX` instead does not help — it is inherited identically. This is the definitive discriminator and needs no allowlist of terminal emulators.

**Own location and layout only.** The queried fields are session name, window index/name, pane index/id, window/pane active flags, and `window_layout`. Pane and window pixel sizes are excluded (layout tree conveys structure; sizes are noisy and change on every terminal resize). Sibling-pane contents are never captured (`capture-pane`), keeping the reading small and avoiding scraping unrelated, possibly sensitive, output.

**Inject only on change, with optional interval floor.** When due, the plugin calls `agent.inject()` for one `user/message` with source `{ kind: 'plugin', plugin: 'tmux-context' }`. Change suppression compares the rendered state block (everything after the turn preamble line) against the latest injection of this source, found by scanning raw durable session events — so the schedule survives compaction and process resume without a process-local cache. The optional `refreshIntervalMs` (manually validated as a non-negative safe integer at plugin load) additionally suppresses injections within that window of the latest one.

### Text

```text
tmux location (turn <turn>):
session <session>, window <index> "<name>", pane <index> <pane-id>
window active=<0|1>, pane active=<0|1>, layout <window-layout>
```

The turn preamble is the volatile first line; the two-line state block below it is the unit compared for change suppression, so re-injection is driven by tmux state, not loop position.

### Durability and request reconstruction

Each reading is a normal surface node until compaction shadows it; the plugin contributes nothing to system-prompt assembly and `request/header` carries no tmux-context text. The reading records a preparation attempt, not a committed step: because the prepended listener runs first, its append may remain when a later `agent/pre-step` listener cancels or fails the attempt, and the append-only log performs no rollback.

The published `./invariant` companion registers no runtime check: a reading is a per-turn snapshot of external tmux state, so the session holds no cross-event relation to validate, and scheduling and format stay pinned by the package's pipeline tests.

## Consequences

An agent booted inside tmux now receives its own session/window/pane location and window layout as durable, source-attributed context, updated per turn when the location changes. The shipped TUI opts in; custom deployments may compose the plugin directly. Outside a real tmux pane — including a terminal that merely inherited `$TMUX`/`$TMUX_PANE` — or without a `ctx.shell` executor, the plugin is inert with no error, so composing it is safe everywhere. Because the reading is one durable `user/message`, it survives compaction as ordinary history, contributes nothing to system-prompt assembly or request headers, and costs at most one two-line message per changed turn. The pull model adds one `tmux display-message` subprocess (through the sandboxed bash seam) on the first step of each turn that is due. The optional interval floor is checked before the query and so suppresses both; an unchanged location is detected only by comparing the returned state, so it suppresses the injection while still paying for the query.

## Testing

Unit tests pin: first-step injection and source/surface metadata; the `$TMUX_PANE`-keyed command including its `#{pane_tty}`-vs-`ps -o tty=` guard; step-gating; change suppression across turns and re-injection on a moved pane; positive-interval suppression and threshold; every no-op path (no bash, nonzero exit, wrong field count, empty pane id, aborted signal, and a contained executor rejection from either `resolve()` or `run()` that warns instead of failing the turn); prepended ordering before ordinary `agent/pre-step` listeners; resilience to a corrupt prior reading (non-text block, single-line text); and config rejection of negative and non-integer intervals. Per-file coverage is 100%.

## Alternatives considered

- **Push from a tmux hook / background watcher** — rejected: requires installing hooks in the user's tmux and a background process with teardown, to gain mid-step freshness that per-turn context does not need.
- **Run every step** — rejected: location is stable within a turn; re-querying adds token cost without new information. Gating on `step === 1` yields per-turn readings.
- **Raw `child_process`** — rejected: bypasses the sandbox policy path and hand-rolls subprocess code the `ctx.shell` executor already owns.
- **Include pane/window pixel sizes** — rejected: sizes churn on every resize and add noise; the layout tree already conveys structure.
- **Scrape sibling panes with `capture-pane`** — rejected: large, noisy, and privacy-sensitive; out of scope for "own location".
- **Dynamic system-prompt section** — rejected: replacing a value erases the earlier readings behind prior reasoning and is not reconstructable; one durable attributed message records each location where it became visible.
- **Trust `$TMUX_PANE` (or `$TMUX`) presence** — rejected: both are inherited by terminals launched from a tmux shell (VS Code integrated terminal), so a non-pane process injects a stale location. The pane `#{pane_tty}` vs. this process's controlling tty is the definitive check.
- **Denylist known terminal emulators (e.g. `TERM_PROGRAM=vscode`)** — rejected: a partial, ever-growing list that still misses other launchers; the tty match is exact and launcher-agnostic.
- **A runtime invariant validating each reading's turn, position, and format** — shipped initially, then removed: it re-derived the producer's own scheduling from the log and asserted a regex over text the same package had just rendered, so it restated `apply()` rather than checking an independent relation. Every failure it could report required an edit to this package, which its pipeline tests already catch. Reintroduce a companion check only for a relation the plugin does not itself compute — for example if readings gain cross-turn ordering or enclosure obligations that another package can violate.
