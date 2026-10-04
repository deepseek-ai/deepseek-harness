---
description: "Virtualized raw Session log and Chat group/node tables with streamed delta rows, pagination, and update highlighting."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-session-inspector

English | [中文](README.zh.md)

## Summary

Inspect raw Session logs and Chat structures through the optional [Developer Tools bundle](../inspector-profile/README.md). Open **Session Log** from the Sidebar's new-tab menu or guide, then choose **Raw Log** or **Chat Group** from its upper-left selector. Follow object references between Nodes, Turns, and Steps, or locate a selected Node in Chat. Stream chunks appear as child rows, and Chat updates briefly highlight their rows. Both presentations support older history and resizable details without a composer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Developer Tools bundle mounts this plugin as `session-inspector`. It registers the `session-inspector-log` Sidebar page for the Sidebar's current Session, without a Conversation View or header label. The selector initially shows Session Log, with the current row count alongside it. Changing presentation resets local selection, type filtering, and scroll state. This plugin requires no debugging argument, accepts no configuration, and changes no Session data.

Click the filter icon in the Type header to enter a type fragment. Suggestions update asynchronously from all loaded records. Enter or **Apply filter** confirms the fragment; clicking a suggestion or selecting it with arrow keys and Enter confirms that type. Matching ignores case and uses containment: `delta` and `*delta*` both match reasoning and tool-call deltas. Editing alone does not change the table. Escape, Cancel, or clicking outside discards the draft; clearing and confirming restores all types.

Filtered tables retain matching rows and their ancestor context, initially expanding folded ancestors. Context-only types appear muted and do not count toward the matching-row total. New and paginated rows use the confirmed filter. Confirming resets selection, disclosure choices, and reserved trailing space, and returns to the top. Following an object reference or picking a Chat element clears the filter if its target row is excluded, then reveals that row.

Session Log groups records between `turn/start` and `turn/end`, with nested `step/start`–`step/end` ranges. The start record is the sticky group header; the end remains a raw child at the group's tail. Turn and Step groups stay expanded after completion and can be folded manually. Records between Steps belong to the Turn; records outside a loaded range remain ungrouped. Missing starts are not synthesized: loading an earlier start adds ancestry to the existing rows. Assistant streams retain their own nesting inside the Step.

Assistant logs group original timed chunks beneath their matching `block-start`, including text, reasoning, and tool-call argument deltas. Unfinished blocks expand by default; `block-end` automatically collapses its block, which can then be reopened manually. Historical closed blocks start collapsed. Live chunks share an attempt row until settlement replaces them with the durable event. Chat Group nests actual group members below their group. Hidden or unlisted materialized Nodes remain root rows, inserted by event anchor between the existing roots instead of appended after the last Turn; the Inspector does not invent group membership. Inserts and updates briefly highlight unless the system requests reduced motion.

Use the disclosure arrow to fold children and select a row's type or data to inspect raw details. Horizontal data previews omit `type`, `seq`, and `sequence`, plus top-level `time`. Chat Node also omits top-level `key` and `kind`, which already have their own columns. When one field remains, only its value appears. Tool-call delta previews show only the argument fragment; reasoning delta previews show only the text. Preview filtering does not remove fields from raw details. Drag the detail panel's upper separator, or use its Up/Down keys, to resize it; selecting another row retains its height.

A folded reasoning `block-start` omits `index` and shows `blockType: reasoning` followed by its joined reasoning deltas, within the normal preview length. Interleaved blocks keep separate summaries. Expanding the block restores its ordinary fields and original child rows; raw details retain the original block-start without synthesized text.

Chat details show a lazy object tree rather than JSON conversion. Maps retain object keys and values, Sets and arrays show members, and class instances retain their names and own fields. Collections expand in pages; getters are labelled without execution, and WeakMap/WeakSet contents remain opaque. The inspected root expands inline; unregistered cycles show their ancestor path. Expanded fields are cached until a Conversation publication changes, so mutable Turn/Step Data refreshes without resetting disclosure state or repeating enumeration for UI-only renders.

Arrays and TypedArrays read only the disclosed index prefix, including sparse slots marked separately from explicit `undefined`. **Other properties** opens their non-index and symbol fields without invoking getters. The initial numeric page does not enumerate the whole collection; opening Other properties explicitly scans its own keys.

Nested Node, Group, Turn, Step, and Data objects have reference buttons. Activating a reference opens its current loaded value and adds a breadcrumb; selecting an earlier breadcrumb returns to that level and discards the later path. The first breadcrumb retains the original row even when reference navigation selects another table row. A reference with a row unfolds its enclosing Inspector group, scrolls to the row, and flashes it. Node Data also has an inline disclosure arrow: expanding it stays in the current tree, while clicking its title navigates. Repeated Node Data ancestors remain links rather than recursively expanding. Selecting a table row or a picked Chat element starts a new breadcrumb path; Session Log keeps JSON details without reference navigation.

Selecting a Chat row or following a reference uses the Inspector's [DOM matcher](src/client/views/chat-node/dom.ts) to find existing Node, call, Group, or Turn attributes in the same Session's displayed main Chat. Inspector dispatches the existing `beforematch` behavior to searchable folded ancestors, then uses native scrolling and a body-level highlight overlay without adding elements to Chat content. A visible target only flashes; an offscreen target scrolls smoothly before flashing, with immediate scrolling and no flash for reduced motion. ID columns remain narrow; hover or focus an ID to read its complete value in a tooltip.

Missing, empty, or still-hidden occurrences do not stop navigation. When event coordinates are available, Inspector tries nearby loaded content in the same Step, then the same Turn, then other loaded Turns, ordered by event distance. Existing Group and Turn occurrences also provide fallback positions. If no candidate can render, Inspector highlights the visible Chat column without moving it.

Selecting a Session Log row passes the [original log coordinates](src/client/views/session-log/chat-target.ts) through the same DOM lookup while retaining the log presentation and JSON details. Inspector reads the existing Chat snapshot and prefers tool call identity, exact event anchors, and the owning Assistant step before applying the same fallback selection. Stream children inherit their owning event and prefer reasoning or response parts when available. Missing targets do not load history or switch the active View; an empty Chat has nothing to highlight.

The crosshair beside the presentation selector installs a transparent click-catching mask over the displayed main Chat. Inspector uses `elementsFromPoint()` to look below its mask and preview, then matches existing data attributes. A click selects that record in the current Inspector presentation, reveals its table ancestors, and opens its details without activating the underlying Chat control. Wheel movement is forwarded to the underlying Chat scrollport. Escape, the crosshair button, changing presentation or Session, hiding or closing the Inspector, or leaving the window cancels picking. Each plugin instance permits one active picker; separate instances do not cancel one another. Plugin unload releases its picker without calling panel callbacks and prevents old panels from restarting it.

Chat picking prefers the exact Node and reasoning/response part, then its Group, Step, or Turn. Session Log picking prefers a matching tool call or Node log anchor, then its Assistant, Step, or Turn record; a reasoning part selects its first reasoning block when available. Picking stays active with a notice if the loaded table has no match. Text similarity is not used. The [element and Chat-row matchers](src/client/views/chat-node/pick-match.ts) and the [log model's picker](src/client/views/session-log/model.ts) own these adjustable rules; nested tool calls may resolve to their root Node or log anchor.

Session Log uses the same field renderer for parsed JSON, with every nested object and array initially expanded. Containers can be collapsed individually; there are no reference buttons, breadcrumbs, collection-property disclosures, or collection paging. JSON retains `[Circular]` markers and readable bigint strings. Inspection failures appear locally without disabling the table. Preview filtering never removes fields from either detail presentation.

Ancestor rows remain sticky beneath the table header, one nesting level below another, with an opaque tinted background. Each level follows the first row not covered by the header or earlier sticky levels. Automatic block closure keeps the visible row or surviving parent at its screen position and leaves unused space only below the data; new rows fill that space before normal tail following resumes. A manual disclosure keeps the clicked header at its measured viewport position and pauses following, retaining only the trailing space needed to keep it visible. **Follow Latest** clears reserved space and resumes following. Scrolling upward or choosing **Load earlier** also pauses following. Raw Log shows UTC timestamps with the server's millisecond precision; Chat Group has no time column.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) is the inert Host discovery entry. The [tab registration](src/client/views/index.ts) contributes a page type and its Session-scoped body, borrowing the Sidebar's existing Session reference. The [combined panel](src/client/views/View.tsx) selects between the [log model](src/client/views/session-log/model.ts) and [Chat model](src/client/views/chat-node/model.ts); only the selected table subscribes. The [object index](src/client/views/chat-node/objects.ts) uses weak identities for Node and Group snapshots, their data roots, and Turn/Step locations and Data readers. Named references read current values without retaining replaced snapshots. Node enumeration uses the existing `nodes.values()` reader. The [revealer](src/client/views/chat-node/reveal.ts) and [picker](src/client/views/chat-node/picker.ts) own all DOM interaction inside this package; neither adds a Chat or Conversation API. The shared [table](src/client/views/InspectorTable.tsx) uses TanStack Virtualizer.

Live log appends reuse historical row objects and the Turn/Step grouping cursor. Each chunk inserts one row into its block, replaces a closing header when needed, and shifts only following root offsets. Pagination, settlement, replacement, or missed revisions rebuild the hierarchy while preserving keyed record sources. DOM strings are matched to current Group references before registry access; ungrouped Chat keys retain their upstream string type without brand assertions.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this Inspector adds no model-facing input.

#### KV Cache effect

None; the package does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Loaded history** — tables inspect the Session's loaded window; older records require pagination. Live-to-durable row identities persist across window rebuilds and are released when their rows leave the window.
- **Projection controls** — Session Log does not display projection control-stream updates.
- **Publication cadence** — highlighting follows published Node changes, not every internal mutation between publications. Raw data is unredacted.
- **Large windows** — each publication still copies the immutable row-reference array; filtering and table layout also scan the loaded rows. Appends do not regroup or recreate historical rows. Opening ordinary-object fields or Other properties scans all own keys.
- **Live suggestions** — refreshing type candidates resets keyboard selection, even for an unchanged candidate list; reselect the candidate or click it before confirming.
- **Chat DOM dependency** — location and picking depend on existing Slot/Chat attributes and searchable-fold behavior. They require the inspected Session's Chat to be displayed in the main area; they do not switch Views or Sessions, load history, or render absent business Nodes. Approximation cannot recover an unrendered message's exact location.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
