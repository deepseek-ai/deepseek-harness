# Agent Note: PTC mode chat rendering — sub-calls as native rows under the parent

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-ptc-chat-subcall-rows.zh.md)

> Scope: how the web chat view renders a `run_code` turn — the client-side half of the PTC mode UI stack, built on the [host foundation](2026-07-26-ptc-dispatch-ui-foundation.md) (full-content `tool/code-dispatch`, the required `description` parameter). The [toolview dissolution](../architecture/2026-07-23-toolview-dissolution.md) owns the slot model this rides on.

## Problem

With PTC mode enabled, the chat view showed one opaque `run_code` row: raw program text as the summary, sub-calls invisible everywhere. The settled product requirement is the opposite: each sub-call must render *identically* to a native tool call — same row components, same custom registrations, same details panel — while the transcript stays honest about the fact that the model made ONE call.

## Decision

**Sub-calls are standard Tool call blocks attached recursively to their parent outside the surface flow, rendered through the same keyed slot as native rows, and always visible under their parent.**

- **Data layer**: Runtime's `ToolCallTree` folds in-window `tool/code-dispatch-start` and `tool/code-dispatch` events into a private per-parent index, then projects running and settled children onto recursive `ToolCallBlock.subCalls`. Live Session projection and `projectConversationHistory` share that fold; copy-on-write parent arrays and path-copy projection keep unrelated roots and siblings reference-stable. Sub-calls never join `nodes` — the surface flow remains exactly the model-visible turn structure. The events are narrowed structurally at the wire-consumer boundary, which also rejects cyclic parent relationships (dsh-tools' host types cannot enter the client program because the host/client `Context` merges collide).
- **Render layer**: `ChatView` passes each parent with its recursive children through the whole-Tool `'conversation.chat.tool'` seat. ui-tool's `ToolCallTree` renders the parent followed by `[data-subcalls]` nests, and every atomic call dispatches through the same `'tool.call.toolview'` keyed slot with `entryKey = Tool name` and the same `GenericToolCard` fallback. A keyed registration therefore takes over descendant and top-level calls without registration changes. Running parents (`runningCalls`) receive accumulated dispatches in the same recursive block, so child rows stream in during the run.
- **`run_code` presentation**: a new `code` row variant (classifier `run_code → code`, `Code` title, `IconCodeOutline16`) summarizes with the model-authored `description` and expands to the program itself (monospace on the markdown code-block fill) rather than the args JSON envelope.
- **Details panel**: `materialFor` recursively searches `nodes` and `runningCalls`, so a selected descendant callId resolves to full args and complete output through the identical rendering path as a native settled call.

## Alternatives considered

**Sub-calls flat in the surface flow (fold them into `nodes`).** Rejected: misrepresents the transcript — the model made one call; nesting under the parent preserves the code↔calls association and keeps the fold's model-visible-order invariant untouched.

**Hidden until the parent row expands.** Rejected by product decision: the sub-calls ARE the story of a PTC mode turn; hiding them re-creates the opacity this feature removes. The parent's expand toggle reveals only the program.

**A dedicated sub-call row component.** Rejected: the whole point is identity with native rows; a parallel component would drift. The nest wrapper (indent + left edge) is the only sub-call-specific chrome.

## Consequences

Custom toolview registrations apply to sub-calls for free — and deliberately: there is no per-registration opt-out short of the component reading its own context, which no current consumer needs. Selection highlighting reaches nested rows through the same `selectedCallId` channel (group membership searches the whole tree). Trajectory/waterfall now draw sub-call spans from the dispatch timing pair ([live parallel dispatch](2026-07-26-ptc-live-parallel-dispatch.md)); without that timing a waterfall span would be a lie. Fixture turn 64 (`?fixture`) plus the `ptc-round` browser e2e (recorded real round, keyless replay) pin the full surface; the jsdom and Runtime suites pin slot dispatch, error states, recursive details resolution, history projection, and reference-stable path copying.
