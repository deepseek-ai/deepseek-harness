---
description: "The Session panel's background-jobs section: expandable streaming output panels, live rows above a folded finished list, and static rows for settled jobs without retained output."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-jobs` shows the session's background jobs in the Session panel's Background jobs section, with lifecycle, elapsed time, progress, and terminal detail. Live jobs and settled jobs with retained output offer expandable output panels; collapsing stops the stream. Live rows show the label above the kind, current progress, and a ticking duration. Settled rows fold under a count; those without retained output, including subagents whose answers went to the model, stay static.

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

Load the plugin through the web-app manifest. It registers the [Session panel](../ui-session-panel/README.md#contribute-a-section) section `background-jobs` at order 300, after Subagents, titled “Background jobs”. While jobs run and the panel does not show, a blue dot on the panel toggle (`conversation.session.panel.indicator`) says so and names their number for assistive technology; it keeps the Session's roster stream open while the toggle is mounted. The section renders nothing until the session can see at least one job, so the panel hides it together with its title and an ordinary conversation shows no section for a capability it is not using.

Live rows come first, the most recently started first; settled rows follow newest-first under a “Finished {count}” toggle, whose chevron follows the text, with a “Clear” action. The toggle starts folded while a job is live and open otherwise; the user's choice holds for the Session, also after the panel is hidden and shown again. Each of the two groups shows five rows and then the Session panel's fold control as its last row, “Show {count} more running” or “Show {count} more finished”, which shows the rest and then reads “Show less”; a group folds only when that holds back two rows or more. That choice also holds for the Session, and Clear folds the settled group to five rows again. An expanded row stops observing its output while its group holds it back. Each row is one 28px line with the command, then the duration, the stop control while the job runs, and a chevron at its end, in the Session panel's columns; the whole row, chevron included, expands and collapses it. A command the row clips crawls into view while the pointer rests on the row, and the stop control names its action after 500ms of hover. Resting the pointer on a row for 500ms opens a hover card with the job kind, the status or terminal detail, and the duration, but not the command, which can run to many lines and shows in full, with Copy, in the expanded output panel; the card stays closed while the pointer rests on the stop control; assistive technology reads the kind and status as the row's description. A job that finished with a nonzero exit code shows the warning dot, like a stopped one, and a `failed` job the error dot. The settled list folds while any job is live and opens when only settled jobs remain; pressing the toggle overrides that default. Clear hides the current settled rows in this client while the Session stays open, also after the panel is hidden and shown again; the registry keeps their records, a job that settles later appears normally, and the section hides when no rows remain.

Pressing an observable row expands its output panel, and pressing it again collapses it; one row expands at a time. Each duration has a tooltip, “Running for {duration}” on live rows and “Took {duration}” on settled rows, and live durations advance once per second while any job is live.

### One row per job

The `job.list` stream `ctx.jobs` mirrors is the single roster: each `JobView` row carries lifecycle, duration, the live `progress` line or the terminal `detail`, and its retained byte count — a live job, or a settled one with retained output, is what makes a row expandable. There is no second roster to join.

Running job rows also carry a two-press stop control, whose tooltip reads “Stop task” without the command: the first press arms it and widens it into a “Confirm stop” button, the confirming press within three seconds calls `ctx.jobs.kill`, and the row converges through the roster stream (`stopping`, then the settled list, whose detail carries `cancelled by the user`). A rejected kill shows “Stop failed” for four seconds. The kill claims nothing in the model's notice ledger, so the owning agent still receives the standard completion notice — the model is told the user stopped its task rather than left to infer it ([reference](../../jobs/tool-jobs/README.md)).

### The expanded panel

Expanding an observable row opens that job's output observation stream from `ctx.jobs` (installed by `dsh-api-job-controller`) into an embedded terminal panel. The panel copies the command (not the output), wraps commands and output lines in full, scrolls its output inside a fixed height instead of folding, and draws no run-state dot of its own — the row above carries the state. Retention gaps and stream interruptions render as notices above the panel.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `conversation.session.panel.section` registration renders the section body; the Session panel draws its title, supplies its inset, and scrolls it. All data arrives through `ctx.jobs` — the component holds no transport state. The roster follows the mount: one `useEffect` keeps the session's `job.list` stream open while the section is mounted, which is while the Session panel shows. Observation follows visibility: another `useEffect` opens the stream for the expanded row's job and closes it on collapse or unmount, including when the panel hides.

| File | Role |
|---|---|
| [`src/client/JobsSection.tsx`](src/client/JobsSection.tsx) | The section: live and settled rows, durations, the stop control, output panels |
| [`src/client/jobs-store.ts`](src/client/jobs-store.ts) | Per-Session store of cleared rows |
| [`src/client/index.ts`](src/client/index.ts) | Session panel section registration and the dictionaries |
| [`src/client/locales.ts`](src/client/locales.ts) | The `job` namespace copy (zh source of truth) |

Background-job rows use the standard menu item radius from the [nested geometry rules](../../../docs/ui-radius.md#nested-hover); controls inside a filled running row retain compact corners.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-api-job-controller`](../../api/job-controller/README.md) — the `job.list` and `job.follow` streams, the `job.kill` Remote, and the `ctx.jobs` service behind the rows, the panel, and the stop control.
- [`dsh-jobs`](../../jobs/jobs/README.md) — the registry contract that owns the ring and projection semantics.
- [`dsh-client-ui-session-panel`](../ui-session-panel/README.md) — the Session panel that orders, titles, and scrolls this section.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — the `TerminalBlock` surface the panel configures.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders host-observed state and live output for a human and touches no prompt, message, schema, stream, or tool result. The model's own view of the same work stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **Channel labels are not rendered** — stdout and stderr chunks concatenate into one stream; per-channel tinting is a presentation follow-up.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
