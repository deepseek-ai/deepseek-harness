---
description: "Opt-in per-turn tmux location context for users and maintainers enabling or tuning the agent's session, window, and pane awareness."
kind: "package-reference"
---

# @deepseek-ai/dsh-tmux-context

English | [中文](README.zh.md)

## Summary

`dsh-tmux-context` tells the model where its agent process runs: on each turn whose tmux state changed, it appends a durable, source-attributed reading naming the tmux session, window, and pane plus the window's pane-tree layout. It is sampled once per turn during request preparation and only when the process genuinely lives inside the named pane — a terminal that merely inherited `$TMUX`/`$TMUX_PANE` from a tmux ancestor reads as not in tmux and adds nothing. An unchanged location adds nothing, and a failed query is a no-op, never a turn failure. The plugin is opt-in and not part of the shipped Web/headless composition.

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

Mount this plugin when the agent process runs inside tmux and the model benefits from knowing its window and pane location. Each reading is one additional user-role message in durable history; an unchanged location adds nothing, so long-running sessions accumulate little.

### What the agent gets

On each turn whose tmux state changed, the model receives one source-tagged context message with the session name, window index and name, pane index and id, active flags, and the compact pane-tree layout. Readings happen on the first step of a turn only; a pane moved or resized mid-turn is reflected on the next turn. Pixel sizes are intentionally excluded, and the visible contents of sibling panes are never captured.

### Configuration

The minimal mount needs no configuration. A positive `refreshIntervalMs` additionally suppresses injections that fall within that many milliseconds of the latest one; omission or `0` injects whenever the tmux state changed since the last injection.

```yaml
- name: '@deepseek-ai/dsh-tmux-context'
  config:
    refreshIntervalMs: 60000
```

| Field | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | `0` (every changed turn) | Minimum milliseconds between durable injections in one session |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tmux-context) is the exhaustive source for every accepted field and its JSDoc.

### When the location is known

The process counts as in tmux only when its controlling terminal matches the pane's `#{pane_tty}`; a terminal launched from a tmux shell (a VS Code integrated terminal, a desktop launcher) inherits the variables but not the pane, so it reads as not in tmux. A missing `ctx.shell`, an absent environment, or a malformed reading is a no-op, and an executor rejection is contained and logged as a warning rather than failing the turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The plugin prepends an `agent/pre-step` listener that runs only on the first step of each turn. When due, it runs one read-only command through the `ctx.shell` executor service — the deployment's sandbox and policy apply, and the plugin owns no subprocess code. The command compares `$TMUX_PANE`'s `#{pane_tty}` with this process's own controlling terminal before emitting tab-separated fields, so an inherited environment reads as not in tmux. The plugin re-injects only when the rendered state differs from its last injection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: first-step listener, shell query, change suppression, scheduling |
| — | No runtime invariant companion is published; a reading is a per-turn snapshot of external tmux state, so the session holds no cross-event relation to check; scheduling and format are owned by pipeline tests. |

### Main flow

At the first step of a turn, the listener checks whether an injection is due, queries the location through `ctx.shell`, and compares the rendered state with the latest durable injection of this source. Change suppression and interval scheduling scan the raw durable session events, so the schedule survives compaction and resumed processes without process-local cache state; sessions schedule independently. A downstream pre-step listener that rejects or fails prevents the reading from being recorded.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the design decision to the executor the query runs through and the exhaustive configuration.

- [Tmux location context decision record](../../../.agents/notes/archived/feature/2026-07-27-tmux-location-context.md) — design rationale for the tty-based detection and reading shape.
- [Shell subsystem](../../../docs/subsystems/shell.md) — the executor service the read-only query runs through.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tmux-context) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Preparation-time tmux location

#### What the model sees

On each turn whose tmux state changed, one source-tagged context message with the three lines below. `<window-layout>` is tmux's compact pane-tree description; pane and window pixel sizes are intentionally excluded, and the contents of sibling panes are never captured.

##### Changed-turn reading

```markdown
tmux location (turn <turn>):
session <session>, window <index> "<name>", pane <index> <pane-id>
window active=<0|1>, pane active=<0|1>, layout <window-layout>
```

#### Token effect

Each three-line reading accumulates until compaction shadows it. Unchanged locations and interval suppression add nothing.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when tmux location context is a poor fit. They are current package constraints.

- **First step only** — a pane moved or resized mid-turn is reflected on the next turn, not between steps.
- **Own location only** — the plugin never captures the visible text of sibling panes.
- **Layout, not size** — pane/window pixel dimensions are omitted; only the layout tree and active flags are reported.
- **Tab-delimited fields** — a tmux window name containing the literal two-character sequence `\t` would mis-split the reading and be skipped as malformed; ordinary names are unaffected.
- **tty-based pane detection** — the process is considered "in tmux" only when its controlling terminal matches `$TMUX_PANE`'s `#{pane_tty}`. This deliberately excludes terminals that inherited `$TMUX`/`$TMUX_PANE` from a tmux ancestor (e.g. a VS Code integrated terminal). `ps -o tty=` is POSIX; the check is a no-op wherever it or `#{pane_tty}` is unavailable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
