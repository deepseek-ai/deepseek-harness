---
description: "Experimental conversation view showing per-turn and per-step context size, first-token latency, model versus tool time, cache hit rate, and output speed."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-stats

English | [中文](README.zh.md)

## Summary

Adds a Statistics tab beside Chat and Trajectory. Turn rows expand into steps with context and output tokens, cache hit rate, first-token latency, model and tool time, output speed, and a total-time bar. Scrolling up pulls earlier turns through shared Session paging. The Trigger column names what opened the turn, including a team message's sender, and prompt images show a count pill with a hover preview in the shared viewer. The tab reads Session events and durable prompt images; it registers no tool, prompt section, or service.

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

Mount it in a client composition that already provides `slots`, `sessions`, `uiConversation`, and `locale`. It contributes one entry to the `conversation.view` slot; no configuration fields exist.

### When to choose it

Choose it when you need to compare turns or steps by prompt length, cache reuse, and where wall time went. Choose `@deepseek-ai/dsh-client-ui-trajectory` when you need the full event ledger with request headers and tool payloads; the two panels read the same Session and can be enabled together.

### Minimal configuration

```yaml
- id: ui-stats
  name: '@deepseek-ai/dsh-experimental-client-ui-stats'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Six Conversation Definitions fold the event window into nodes for one view target named `stats`. `stats-step` owns one context per `step/start`; `stats-prompt` owns one context per waking user message (human prompt or automated trigger); `stats-turn-end` records the turn boundary so an interrupted tail closes; `stats-code-mode` owns one context per Code-Mode root call for the inner dispatches its runner performed; `stats-compaction` owns one compaction transaction; `stats-event` owns the non-step request, prompt, retry, approval, and prune rows. Turn and step identity comes from the engine's match Location, never from module state, so history paging and multiple Sessions cannot cross-attribute events.

| File | Responsibility |
| --- | --- |
| `src/client/stats-definition.ts` | The six Definitions, their match rules, publication cadence, and node envelopes |
| `src/client/stats-fold.ts` | Event folding, tool pairing, Code-Mode dispatch attribution, and per-step metrics |
| `src/client/stats-aggregate.ts` | Turn aggregation and ordering, the interrupted-tail close, and the Code-Mode merge into the owning step |
| `src/client/stats-compaction.ts` | Compaction transaction state and its synthetic summary row |
| `src/client/stats-event.ts` | Normalization of non-step event rows |
| `src/client/stats-format.ts` | Display formatting for timestamps, durations, tokens, and percentages |
| `src/client/stats-usage.ts` | Token-usage derivation shared by step, compaction, and totals rows |
| `src/client/stats-totals.ts` | Whole-session totals from the host stats and token-usage projections |
| `src/client/stats-snapshot-builder.ts` | The `stats` view target builder |
| `src/client/StatsView.tsx` | Scrollport with scroll-to-top paging, table, totals and event rows, time bars, step/tool/answer details, copy controls, and the prompt image pill with its preview and viewer |
| `src/client/locales.ts` | Every visible string in all eight shipped languages |

The footer switches control the totals row, event rows, and the context basis, and the footer stays pinned above the composer while the table scrolls. `Show context delta` is off by default; when on, every turn and step shows its prompt-size change against the previous measured value in that scope, with negative deltas (for example after compaction) in the error colour. An expanded step row fills the Trigger column with its start timestamp (`MM-DD HH:MM:SS.mmm`; the tooltip carries the full `YYYY-MM-DD HH:MM:SS.mmm`) and any gap of at least one second since the previous step; sub-second scheduler noise is hidden. A step carrying a model answer is expandable: clicking its row opens a detail row that renders the answer as Markdown through the shared Chat primitive, capped at 16,000 characters with a truncation notice.

`Context basis` changes only how a turn row aggregates its steps: `Latest` shows the turn's final prompt size, while `Cumulative` sums that turn's step prompt sizes. The totals row is not affected by this switch. When the host exposes the `sessionStats` and `tokenUsage` projections, the totals row covers the complete Session: turns, steps, cumulative context and output, token-weighted cache, first-token/model/tool time, and output speed. Total time there is model time + tool time because no whole-session wall projection exists. Without those projections the row falls back to the loaded window and is labelled `Window total`. Token cells switch from `K` to `M` at ten million.

Non-step rows are hidden by default; the `Show event rows (incl. compaction)` footer switch enables them. Compaction is a log-only transaction, not a step. The table inserts a synthetic `Compaction` row between the steps it ran between; the row shows the summary call's context, output and cache-hit cells, the shadowed token count, the summary size, and its wall time. The same switch reveals request-header, route-context, system-prompt, tool-set, model-retry, model-attempt, context-refresh, approval, and model-free prune rows: a request header shows its reason, provider/model, series flag and tool count; a route context shows provider/model and the prompt-update mode; a system prompt shows append/replace/clear and size; a tool-set row lists added and removed tool names; a retry row shows the attempt number, wait, and failure message; an attempt row marks a model attempt that committed no message; a context-refresh row shows runtime/time context refresh size; an approval row shows the tool and waiting/allowed/rejected state; a prune row shows the pruned token count. These rows are excluded from the turn and totals step sums, so the step columns keep their step-only meaning.

The turn cache-hit cell is token-weighted across the steps that reported usage (summed cache reads ÷ summed prompt tokens), so one transient cold step is not hidden by a warmer neighbour; the tooltip shows the summed read/input/write breakdown. A step row keeps its own measured share.

Windows are bounded: when a step's `step/start` is outside the loaded window, its start-dependent columns show `—` with a `start unknown` marker rather than a guessed value. Scrolling to the top asks the Session for one older page; the view offsets the scroll position by the height it prepended, so the row being read stays in place.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-client-ui-trajectory`](../../client/ui-trajectory/README.md) — the event ledger this panel borrows its table conventions from.
- [`@deepseek-ai/dsh-session-stats`](../../session/session-stats/README.md) — the host-side session totals the footer vocabulary follows.
- [`docs/subsystems/conversation.md`](../../../docs/subsystems/conversation.md) — how view targets and Definitions assemble.

-----

<a id="model-experience"></a>
## Model Experience

None, as the tab only reads Session events and renders them in the browser; it registers no tool, prompt section, or model input.

#### KV Cache effect

No effect. The package never constructs a model request and never mutates a prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not mounted by the default product.** The Web bundle refuses experimental packages by rule; the optional Developer tools bundle (`@deepseek-ai/dsh-experimental-inspector-profile`) mounts this view, or a profile can add the row explicitly.
- **Trimmed windows lose start times.** When the loaded window begins mid-step, first-token, model time, and total time cannot be derived; the row says `start unknown` instead of estimating.
- **Code-Mode dispatches merge by root-call context.** Inner calls carry no turn or step, so each root call opens its own context keyed by the root call id, and the builder merges its dispatches into the step that owns the runner. A window that lost the dispatch start still merges the calls but cannot show their measured duration.
- **Older-page retries are explicit.** A page request reports `grew`, `exhausted`, or `retry`; when Chat or Trajectory owns the Session's in-flight page, the Statistics trigger stays visible instead of marking history exhausted or throwing.
- **Known limitation: no whole-session wall projection.** The totals row substitutes model time + tool time because the host projections expose no whole-session wall clock. The tool segment sums paired call durations, so parallel calls can make that split look longer than a non-overlapping wall interval. This is recorded here; the view does not change host logic to fill the gap.
- **Recorded-session coverage is exempted for this experimental PR.** Package tests cover folding, aggregation, formatting, paging, and the jsdom table; `apps/web/tests/client-ui-stats-panel.e2e.ts` mounts the plugin through a test-only overlay over the shipped Web surface and compares a committed ARIA golden. By owner decision, this experimental PR does not add a keyless recorded-session scenario; a profile or bundle promotion must add one.
- **Late re-deliveries are not turns.** Compaction can restate a pruned tool result under its original turn and step after that turn left the window; a turn with no loaded start, prompt, or end marker is dropped instead of appearing as an empty ghost row.
- **Timing is derived, not sampled.** Total time is the last step's end minus the first step's start; queueing and scheduler waits land in the "rest" segment. The total-time bar draws tool calls as the union of their paired intervals, so parallel calls count once; the tool column keeps the summed per-call time. A turn bar is scaled against the turns currently visible on screen, so a much larger turn that scrolled away does not flatten the rows in view.
- **Prompt images load through the shared image cache.** The pill and its preview resolve durable attachments with `uiConversation.imageUrl`, so the cache owns and revokes the browser URLs per Session binding; the view creates none of its own. A failed read shows a localized failure state with retry. Touch clients do not open the hover preview; tapping the pill loads the first image directly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The panel was ported from a standalone client plugin. The table vocabulary follows `@deepseek-ai/dsh-session-stats` (model time, tool time, first token, output speed), while the layout follows the Trajectory table so the two tabs read alike.

</details>

**Runtime invariant:** No companion is published. All state derives from the Session event window, so independent observation would restate the register/fold logic rather than assert a distinct relationship.
