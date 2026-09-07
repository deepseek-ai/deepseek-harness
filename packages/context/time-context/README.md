---
description: "Opt-in per-step clock context with the current time, browser zone, and elapsed time, for users and maintainers enabling or tuning the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-time-context

English | [中文](README.zh.md)

## Summary

`dsh-time-context` gives the model a clock: on eligible steps it appends a durable, source-attributed reading with the current time, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message. It helps the model interpret otherwise-unqualified dates and times in the user's browser zone, and tells it to ask when zone provenance is mixed or missing. The plugin is opt-in: default compositions leave it disabled, and the Schedule Web overlay mounts it. A positive `refreshIntervalMs` reduces how often readings accumulate; omission or `0` injects at every eligible step.

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

Mount this plugin when the model should interpret unqualified dates and times in the user's zone, and when a request-local browser zone is available or a configured fallback is acceptable. Each injection is one additional user-role message in the durable history; schedule it with `refreshIntervalMs` when per-step readings are more than the conversation needs.

### What the agent gets

Each injected reading has three lines: an ISO-shaped timestamp with numeric offset and IANA zone, the browser-zone policy for the request, and the elapsed duration in compact whole-second units. Step 1 measures from the latest preceding model-visible message; later steps measure from the preceding time-context event in the same turn. A missing baseline reports `unavailable`, and backward wall-clock movement clamps elapsed time to zero.

### Configuration

The minimal mount needs no configuration. A positive `refreshIntervalMs` suppresses injections that fall within that many milliseconds of the latest one; omission or `0` injects at every eligible entering pre-step whose signal is not already aborted.

```yaml
- name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai
```

| Field | Default | Meaning |
|---|---|---|
| `timeZone` | process zone | Fallback display zone when the open turn has no unique browser zone |
| `refreshIntervalMs` | `0` (every eligible step) | Minimum milliseconds between durable injections in one session |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-time-context) is the exhaustive source for every accepted field and its JSDoc.

### Choosing the zone

When the open turn contains exactly one Host-validated browser zone, the timestamp is formatted in that request-local zone. With missing or mixed browser provenance, the configured `timeZone` formats the display; omitting it resolves the Node process zone once at plugin load, and every explicit fallback is validated through `Intl.DateTimeFormat`. The resolved instruction tells the model to interpret unqualified dates and times in the chosen zone, and to ask the user to clarify when provenance is mixed or unavailable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The plugin prepends an `agent/pre-step` listener that delegates first and appends one sourced `UserMessage` when an injection is due and the downstream decision enters the step. Each reading uses the exact snapshot source `{ kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text }] }`, and the invariant companion validates that shape, re-derives the current-turn browser policy from the original `user-rpc` messages, and checks the timestamp zone and elapsed baseline.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step listener, due scheduling, reading composition |
| [`src/request-zone.ts`](src/request-zone.ts) | Browser-zone policy derivation from open-turn `user-rpc` sources |
| [`src/timestamp.ts`](src/timestamp.ts) | `Intl.DateTimeFormat` creation and timestamp formatting |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion for the snapshot contract |

### Main flow

When an injection is due, the plugin samples the wall clock, derives the browser-zone policy from the open turn's `user-rpc` messages, resolves the display zone (request-local or fallback), and renders the three-line reading. Positive-interval scheduling scans raw durable session events for the latest plugin-attributed message — including one shadowed by compaction — so the schedule survives resume without a process-local cache. A reading records an entered step, not a completed or transmitted request; a later preparation failure can leave it in history.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the design decision to the composition that mounts the plugin and the exhaustive configuration.

- [Schedule user guide](../../../docs/user/guide/schedule.md) — the official configuration path for mounting this plugin.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-time-context) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Preparation-time temporal context

#### What the model sees

Each injected message contains three lines. `<timestamp>` is an ISO-shaped timestamp with numeric offset and IANA zone; durations use compact whole-second units.

##### First step

```markdown
Time sampled while preparing turn <turn>, step 1: <timestamp>
Browser time zone for this request: <iana-zone-or-mixed-or-unavailable-policy>.
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

##### Later steps

```markdown
Time sampled while preparing turn <turn>, step <step>: <timestamp>
Browser time zone for this request: <iana-zone-or-mixed-or-unavailable-policy>.
Elapsed since the preceding step context: <duration-or-unavailable>.
```

#### Token effect

Each reading accumulates until compaction shadows it. A positive interval reduces additions; omission or `0` adds one at every eligible preparation attempt.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when clock context is a poor fit. They are current package constraints.

- **Prompt provenance only** — browser-zone context guides natural-language interpretation but does not silently supply another tool's required zone field.
- **Mixed turns ask** — if one open turn contains prompts from different browser zones, the model is told to clarify rather than guess which one owns an unqualified time.
- **Fallback is not user authority** — the configured or process zone formats the clock when browser provenance is missing or mixed, but the model-facing policy still says to clarify.
- **Whole-second display** — timestamps and durations omit sub-second precision even though durable event times retain milliseconds.
- **History cost between compactions** — omission or `0` retains one reading for every eligible attempt; a positive interval reduces but does not eliminate this cost and may leave a later request without fresh browser-zone guidance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
