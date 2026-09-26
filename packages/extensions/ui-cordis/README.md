---
description: "Historical Cordis cards and controls for process-local runner definitions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cordis

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-cordis` renders historical generated-plugin cards and a control panel for process-local definitions. Users can operate definitions supplied by programmatic consumers; persisted cards remain readable after restart without recreating those definitions. New Creator plugins use Plugin Manager.

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

Compose this package with the Host and Client runners to render historical tool cards and operate programmatically registered definitions in the panel. New agent-authored plugins use Plugin Manager; this package exposes no model mutation tools.

### What the panel shows

A `sidebar.footer.action` seat shows a badge counting what runs plus what waits; opening it lists every definition with its run controls. The list is never filtered by session: the current session's rows group first, everyone else's stay listed below. Rows come from the host's current inventory and update whenever an announcement changes what exists. A pending run request whose definition the last read does not cover still gets a row, rendered from the request's own session, label, purpose, and identity. Each row shows two independent facts — what the host runs and what this page has loaded — and maps them onto the shared status marker: idle uses idle, client loading and an action in flight use ongoing, a running definition uses done, approval waits use warning, and failures use error. A reloaded page offers "load back into this page" before the global stop, while a host-only definition reads plainly running and offers the stop alone. The row also carries this page's last render failure inline, in the same place as a load failure: one is "it never loaded", the other "it loaded and then threw".

### What the tool cards show

Preparing calls show their ordinary Cordis icon and title in one non-expandable row. This stage does not derive a package identity, read its live inventory, or mount its business view; those operations require the start/result props.

The `cordis_define` card is a record: the name and purpose the model wrote, the source it wrote, and whether the definition is running — no switch, no approval, and a pointer to the panel. The `cordis_run` card shows the mode, the plugin, package, and run ids, the outcome, and offers the package's own business view through the `tool.view.cordis` slot when the package registered one. Define, run, stop, and undefine cards retain their ordinary business glyph when they fail or are interrupted, including a correlated activation failure after a successful run receipt. All cards render from the recorded call and result, so replay shows the same card.

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
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: slot registrations and inventory wiring |
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
- [Tool package](../tool-cordis/README.md) — read-only runtime API discovery.
- [Extensions subsystem](../../../docs/subsystems/extensions.md) — the generated `ctx.dynamicCordisRunner` API and forwarded `cordis/*` events.
- [Slots subsystem](../../../docs/subsystems/slots.md) — how slot-registered browser UI is owned by its package.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the runner lifecycle actions that own session steering and permission outcomes; this package renders historical calls and results and adds no tools or prompt sections.

#### KV Cache effect

None directly: this package owns rendering; runner-originated steering changes the session history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the surfaces need special care. They are current package constraints, not a task backlog.

- **An open panel does not see registry changes that announce nothing** — programmatic `define` and inactive `undefine` can leave the current rows unchanged until the next inventory read. A run request triggers a read.
- **A request-only row is answerable but not operable** — it offers approve and decline only, because the run and stop controls need the registry row the read has yet to deliver.
- **A row can disappear for the width of one read** — the activity's orchestrating arm carries the session but deliberately no label, so an approved request whose registry read has not landed leaves no row until it does; in practice the read is triggered when the request arrives.
- **Render failures are page-local and follow the load receipt** — the panel displays this page’s crash; the Host runner steers the owning session separately.
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
