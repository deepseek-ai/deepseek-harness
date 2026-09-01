---
description: "Cordis dynamic-plugin browser surfaces for users and maintainers choosing, composing, or debugging the panel, tool cards, and @pluginId input."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cordis

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-cordis` gives a web client the browser surfaces for dynamic Cordis packages: a frame-wide panel that operates every definition the host holds, tool cards that render `cordis_define`, `cordis_run`, `cordis_stop`, and `cordis_undefine` calls in the conversation, and an `@pluginId` input source that completes the session's defined plugins. The panel is global on purpose — a model-driven run blocks on a person's approval, and that approval must be reachable no matter which session is in view. The package authors nothing the model sees: everything it operates comes from the browser runner and the host's inventory, and the cards render call and result content the conversation already logged.

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

Compose this package in a web client that also mounts the browser runner and the host runner, and it adds the panel, the tool cards, and the `@` completion. A person then has everything needed to run the lifecycle: approve or decline a model's run request, run, stop, or remove any definition, and watch a package's live state change on the same rows.

### What the panel shows

A `sidebar.footer.action` seat shows a badge counting what runs plus what waits; opening it lists every definition with its run controls. The list is never filtered by session: the current session's rows group first, everyone else's stay listed below. Rows come from the host's current inventory and update whenever an announcement changes what exists. A pending run request whose definition the last read does not cover still gets a row, rendered from the request's own session, label, purpose, and identity. Each row shows two independent facts — what the host runs and what this page has loaded — so a reloaded page offers "load back into this page" before the global stop, while a host-only definition reads plainly running and offers the stop alone. The row also carries this page's last render failure inline, in the same place as a load failure: one is "it never loaded", the other "it loaded and then threw".

### What the tool cards show

The `cordis_define` card is a record: the name and purpose the model wrote, the source it wrote, and whether the definition is running — no switch, no approval, and a pointer to the panel. The `cordis_run` card shows the mode, the plugin, package, and run ids, the outcome, and offers the package's own business view through the `tool.view.cordis` slot when the package registered one. `cordis_stop` and `cordis_undefine` render compact action rows. All cards render from the recorded call and result, so replay shows the same card.

### The @pluginId input source

Typing `@` in the input offers the current session's defined plugins; picking one emits `@pluginId`, which the tool package turns into a pinned reference context for the model.

### Boundaries to plan around

Definitions are process-local: a reloaded page holds nothing until someone runs a package again, and the panel re-reads the inventory on every announcement. Approvals are frame-wide by design, so a person in one tab can approve a run the model asked for while another tab shows the defining session; the first answer wins and the rest converge.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the surfaces; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The surfaces are built on one rule: neither keeps run state in component state, because settling a define call moves its card in the chat flow and remounts it. Facts live in observables owned by whoever can close them — the browser runner owns open requests, orchestration outcomes, this page's live set and its render failures, while this package owns the inventory it read and the announcements it folded. The panel is global because a run request blocks the model and can name a definition belonging to a session nobody is looking at; an approval reachable only inside that session's transcript would be unreachable exactly when it blocks the model.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: slot registrations, inventory wiring, `@pluginId` source |
| [`src/client/CordisPanel.tsx`](src/client/CordisPanel.tsx) | The frame-wide panel and its run controls |
| [`src/client/CordisDefineRow.tsx`](src/client/CordisDefineRow.tsx) | The read-only `cordis_define` card |
| [`src/client/CordisRunRow.tsx`](src/client/CordisRunRow.tsx) | The `cordis_run` card and its business-view seat |
| [`src/client/CordisActionRow.tsx`](src/client/CordisActionRow.tsx) | The `cordis_stop` / `cordis_undefine` rows |
| [`src/client/card-model.ts`](src/client/card-model.ts) | Replay-stable view models derived from frozen call/result slices |
| [`src/client/inventory.ts`](src/client/inventory.ts) | The single-flight inventory read and its reconnect handling |
| [`src/client/status.ts`](src/client/status.ts) | The visible status readings over inventory and the page's live set |
| [`src/client/slots.ts`](src/client/slots.ts) | Injected faces and the package-owned `tool.view.cordis` slot declaration |
| [`src/client/run-card-index.ts`](src/client/run-card-index.ts) | Per-session index of the latest eligible `cordis_run` card |

### How the panel stays current

Announcements (`cordis/dynamic-package`, `cordis/dynamic-retract`, `cordis/request-run`, `cordis/request-run-resolved`) trigger an inventory re-read instead of a patch-in-place update, because they carry no labels and a definition can appear or disappear between them. Reads are single-flight so several announcements settling at once cannot multiply the call; a connection reset both discards the in-flight read and frees the slot for a fresh one, so a reconnect never publishes the old host's rows.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the surfaces to the face they operate and the tools whose calls they render.

- [Client runner](../cordis-client-runner/README.md) — the browser face the panel reads and calls.
- [Host runner](../cordis-host-runner/README.md) — the inventory and lifecycle verbs behind the panel.
- [Tool package](../tool-cordis/README.md) — the model-facing tools whose calls these cards render.
- [Extensions subsystem](../../../docs/subsystems/extensions.md) — the generated `ctx.dynamicCordisRunner` API and forwarded `cordis/*` events.
- [Dynamic client render and attachment ownership Agent Note](../../../.agents/notes/implemented/architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md) — how slot-registered browser UI is owned by its package.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the run and stop verbs these surfaces drive — the browser-side runner's orchestration for a run, and the host's stop and remove verbs, the same host verbs the model's `cordis_run` and `cordis_stop` tools reach — so whatever a running definition then contributes is the runner's effect, while nothing model-visible originates in this package, which renders logged call and result slices and a host inventory read, adds no prompt content, writes no session event, and deliberately leaves no session-log trace of a person approving, declining, running, or stopping anything.

#### KV Cache effect

None: no prompt input originates here, and answering a run request neither extends nor rewrites the history tail.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the surfaces need special care. They are current package constraints, not a task backlog.

- **An open panel does not see registry changes that announce nothing** — `cordis_define`, and an undefine of a definition that was not running, change the registry without a dispatch announcement, so a panel left open across one of them keeps its rows until it is closed and opened again. A run request is the exception: it blocks the model, so it both renders its own row and triggers a read.
- **A request-only row is answerable but not operable** — it offers approve and decline only, because the run and stop controls need the registry row the read has yet to deliver.
- **A row can disappear for the width of one read** — the activity's orchestrating arm carries the session but deliberately no label, so an approved request whose registry read has not landed leaves no row until it does; in practice the read is triggered when the request arrives.
- **A render failure is this page's own reading, and it arrives too late for the run receipt** — the panel shows the last crash the runner saw here, so a package that renders fine in this tab shows nothing even while it crashes in another, and the model learns about it by asking (`cordis_inspect_self`) rather than from the call it already made.
- **A second page's load failure is invisible to the others** — the host settles a dispatch on the first load report, so a page whose browser half failed after another page acknowledged keeps reading as running on the other pages.
- **Any page may answer any request** — approvals are frame-wide by design, so a person in one tab can approve a run the model asked for while another tab is in front of the defining session; narrowing who may answer is deferred.
- **A card whose call head left the event window loses its labels** — the define card derives name and purpose from the call arguments, so a session long enough to truncate them leaves the card naming its call id; the panel is unaffected because the host inventory carries the labels.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A single keyed toolview registration whose disposal is proven by the HMR-safety spec. The one mutable relation this package owns — the per-definition run-state observable — lives in the browser process, out of reach of the host invariant service, and the node half emits no cordis events and holds no cross-plugin state.
