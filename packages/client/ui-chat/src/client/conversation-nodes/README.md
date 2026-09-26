---
description: "Detailed business rules for Chat process grouping and activity summaries."
---
# Chat conversation node rules

English | [中文](README.zh.md)

## Summary

A Turn shows an answer and lets the reader inspect the work behind it. Start with the complete example below, then read the folding and display rules to understand what is visible. The later sections define exact group boundaries, every tool-name category, counting, and live-detail selection.

## Table of Contents

- [How one Turn becomes a transcript](#reading-model)
- [Whole-Turn folding](#whole-turn-folding)
- [Display modes](#display-modes)
- [Process grouping](#process-grouping)
- [Activity summaries and tool rules](#activity-summaries)

-----

<a id="reading-model"></a>
## How one Turn becomes a transcript

Grouping, counts, display modes, and whole-Turn folding answer different questions. Grouping decides which process rows belong together. Counts summarize work inside an existing group. Display modes decide how much of each group to show. Without an intervening input, whole-Turn folding can hide the entire process across several groups and intermediate replies.

### A complete example

Suppose the assistant thinks, reads a file, runs a command, posts a progress reply, then thinks and runs code before giving its final answer. After completion, that Turn contains:

- User input.
- Whole-Turn control.
- Process content controlled by the whole-Turn control:
  - Group G1: reasoning, `read`, `bash`.
  - Intermediate reply: outside both groups, but still part of the Turn's process.
  - Group G2: reasoning, `run_code`.
- Final response, outside the process fold.
- Completed-turn footer.

Every reply separates secondary groups; only the final answer is protected from whole-Turn folding. An intermediate reply can be an independent row and still disappear when the Turn is folded. Reasoning attached to the final answer remains process content.

| Question | Deciding rule | Result in this example |
|---|---|---|
| Which rows belong together? | Group boundaries | The reply separates G1 and G2; changing from `read` to `bash` does not. |
| What did a group do? | Category counts | G1 has `read=1, commands=1`; G2 has `code=1`. Reasoning adds no tool count. |
| What does its title say? | Group state and summary | Running groups use their latest running activity; closed groups use their highest-count categories. Counts never decide folding. |
| How much detail is visible? | Display mode and manual group opening | Compact, Standard, and Detailed retain historical group headers; Detailed shows running bodies directly, while Verbose shows both running and historical bodies directly. |
| Is the process visible at all? | Whole-Turn opening | Closing the Turn hides G1, the intermediate reply, and G2 together. |

### What the reader sees

Assume the Turn above completed normally, with no inner disclosure manually opened:

| Viewing state | Visible content |
|---|---|
| Whole Turn collapsed, Compact/Standard/Detailed | Input, whole-Turn control, final response, and footer. No process headers, bodies, or intermediate reply. |
| Whole Turn open, Compact/Standard/Detailed | G1/G2 headers, the intermediate reply, and final response. Group bodies start collapsed. |
| Whole Turn and G1 open, Standard or Detailed | G1's reasoning and tool rows with the settled reasoning preview; G2 remains a header. Full reasoning/tool bodies are still manual. |
| Verbose | Whole-Turn duration/status header without a collapse action, all process rows, intermediate reply, and final response. No group headers; individual tool/reasoning bodies remain manual. |

Visibility applies from outside inward: whole Turn → secondary group → individual reasoning/tool disclosure. Opening an inner layer cannot bypass a closed outer layer. Category changes never open or close a layer. Mode changes preserve membership and manual opening choices.

If steering, a User message, or a trigger notice follows process output, the Turn offers only individual group disclosures, not whole-Turn collapse. In Compact/Standard, `G1 → steering 1 → G2 → steering 2 → G3` retains all three headers and both inputs in that order, with intermediate replies visible; opening one group reveals only its body. Detailed directly shows group bodies only while the Turn runs; completed Turns retain headers and manual disclosure. Verbose shows group bodies directly in both cases. The Turn control still shows duration or status, without a collapse action.

-----

<a id="whole-turn-folding"></a>
## Whole-Turn folding

Whole-Turn folding controls the loaded process range, independently of secondary groups, in Compact, Standard, and Detailed. Verbose keeps that range visible and retains the duration/status header without a collapse action. A recorded Turn end makes that range eligible even when paging has not loaded the Turn start.

The Turn control follows all its opening inputs, including human steering and non-human trigger notices, while waiting for the first Assistant output and after that output arrives. Consecutive inputs before the first process evidence are opening inputs, anchored by the last one. Later inputs retain their positions: even when paging has not loaded their inbox insertions and they temporarily appear as ordinary User messages, preceding process content must not move after them.

| Admitted input | Chat presentation |
|---|---|
| Human message claimed from `next-step` | Steering message, outside process folding. |
| Non-human message in the current `next-turn` claim | Independent, initially collapsed Turn-trigger notice. |
| Non-human message in an idle `next-step` claim | Turn-trigger notice only in Step 1, with a loaded Turn start, a claim after that start, no `next-turn` claim in this Turn, and no human in the same `next-step` batch. |
| Other non-human input | Ordinary Context, retained in the Node Store but omitted from Chat. Unclaimed, canceled, or requeued messages do not establish a waking claim. |

Trigger titles and icons use the recorded `source.kind`: `schedule`, `tool-jobs`, and `cordis-host-runner` identify scheduled work, background work, and plugin updates. Goal, agent, team, subagent, and webhook sources have their own titles; a webhook with `provider: github` uses the GitHub title. Unknown sources use the generic execution-request title. Expanding the notice shows its recorded body; it does not imply successful execution.

| Turn condition | Current behavior |
|---|---|
| Not closed | Keep process content open; whole-Turn collapse is unavailable. Secondary groups still follow the mode table. |
| Stopped or failed | Keep process content open; whole-Turn collapse is unavailable. |
| Visible input after the first process evidence | Whole-Turn collapse is unavailable. Preserve process segments, intermediate replies, and input order; group disclosures remain available. Consecutive opening inputs do not qualify. |
| Other closed Turn with loaded process content | Initially collapse the process; allow manual opening and closing. Neither the Turn start nor the rest of Session history must already be loaded. |
| Closed Turn with no final answer | Collapse all process rows when otherwise eligible. |
| End is loaded but start is absent | Apply the closed-Turn rules above to loaded content. Show no elapsed duration; do not use the first loaded tool/message time as the start. |
| Neither start nor end is loaded | Keep process rows visible and withhold the whole-Turn control. |
| A Turn control exists, but there is no process content | Retain its title, without a collapse action. |

The final answer is the latest Step's settled Assistant reply, provided it has visible reply content and no tool-call block. Its response remains outside whole-Turn folding; its reasoning remains process content. User and steering inputs, trigger notices, terminal errors, max-token notices, and the completed-turn footer remain independent. Secondary grouping treats model retries as separators, but whole-Turn folding still includes retry rows.

Loading an older page preserves the reader's group-opening choices. Newly loaded process content follows the same Turn state while the final answer is unchanged and whole-Turn folding remains eligible. If the page reveals an intervening input, individual group disclosures replace whole-Turn hiding. When the real start arrives, the duration becomes available; loading all history is not an additional folding condition. When new content only extends an existing group at its beginning, that group and its old message rows retain their identities and opening choices. Replies, steering, and other real boundaries in the new page still separate groups; not every new row joins the old group.

Clicking Load older anchors the first visible content item below that button in transcript order, regardless of its position in the viewport. A collapsed group anchors its header; an expanded group skips its header and anchors its first visible member. The whole-Turn process control is excluded because paging can move it ahead of newly loaded work and steering. When a whole Turn is collapsed, the anchor is its first remaining visible message, such as steering or the final answer. Ordinary messages and steering anchor themselves; hidden and empty rows are skipped. Loading more content inside a collapsed group keeps its header stationary; adding earlier groups or rows preserves that same group header while they appear above it.

Paging adds older content above the retained anchor without jumping to the new top. A capped group absorbs the displacement within its scroll range; the outer transcript absorbs the remainder, including when the group first reaches its cap. If the available scroll range is insufficient, compensation stops at the actual limit without adding bottom space. Later content growth keeps the same anchor until a reading gesture or explicit navigation releases it. Typing or clicking within the composer and non-scrolling transcript keys retain the anchor. If the reader scrolls while a page is loading, scrolling takes priority and its settled reading position becomes the new paging anchor.

A running clock updates in whole seconds, starts at one second, and uses hours from 60 minutes. Completion fixes the duration; cancellation and failure replace it with their status. Lifecycle changes have a polite announcement; clock ticks do not. This control is Chat's only Turn-level running indicator.

Automatic collapse keeps the process open if hiding it would hide keyboard focus. Manual closing focuses the process control before hiding its members. Closing a whole Turn resets its groups and inner reasoning/tool disclosures; it does not reset unrelated renderer state. Browser find can reveal searchable hidden content.

-----

<a id="display-modes"></a>
## Display modes

Settings → General → Work details offers `compact`, `standard` (default), `detailed`, and `verbose`; its description is “Choose how much detail to show for tool calls”. A saved `normal` reads as `standard`, and a saved `expanded` reads as `detailed`, without automatic write-back. Existing `detailed` remains `detailed`. Missing or invalid values, including the period before Host settings arrive, use `standard`; invalid values in other settings still fail validation.

| Behavior | Compact | Standard | Detailed | Verbose |
|---|---|---|---|---|
| Process-group header | Category summary | Summary and live task detail | Hidden in running Turns; retained in historical Turns | Hidden |
| Process-group body | Initially collapsed | Initially collapsed | Directly visible without a group-level height cap in running Turns; manual disclosure in historical Turns | Directly visible without a group-level height cap in running and historical Turns |
| Settled reasoning preview | Hidden | First line | First line | First line |
| Individual reasoning and tool bodies | Manual expansion | Manual expansion | Manual expansion | Manual expansion |
| Eligible completed Turn | Initially collapsed | Initially collapsed | Initially collapsed | Always open; duration/status header cannot collapse it |

A closed group's header names the first three categories from its ranked summary, without displaying counts. A group without categories uses the thinking label. A running header names its live tool category, otherwise thinking; Standard appends live detail. Live titles remain visible for at least 150ms, retaining only the newest pending title.

### Group-title rules

All three stages share the tool-name classification below. A preparing Tool node uses its category's preparation label: read files for `read`, read images for `read_image`, write files for `write`, edit files for `edit` and `apply_patch`, and update the plan for `todo_write` and goal tools. Only the generic “Preparing tool calls” category appends the wire tool name in Standard mode; other categories omit it. It contributes one call without parsing arguments and renders one non-expandable row. A named live delta can create this node; historical calls start directly from tool/call without replaying preparation.

The labels below describe recorded activity, not successful outcomes. For example, a failed read still participates in the “Read files” category.

| Category | Running label | Closed label |
|---|---|---|
| No live category / no counted categories | Analyzing the request | Analysis completed |
| `read` | Reading files | Read files |
| `readImage` | Reading images | Read images |
| `search` | Searching code | Searched code |
| `write` | Writing files | Wrote files |
| `edit` | Editing files | Edited files |
| `commands` | Running commands | Ran commands |
| `code` | Running code | Ran code |
| `webSearch` | Searching the web | Searched the web |
| `webFetch` | Visiting web pages | Visited web pages |
| `subagents` | Coordinating subagents | Coordinated subagents |
| `plan` | Updating the plan | Updated the plan |
| `questions` | Waiting for your action | Asked questions |
| `tools` | Calling tools | Called tools |

| Group state | Title composition |
|---|---|
| Not closed, with a running tool | Use the live category, not the highest-count category. Standard appends nonempty detail with ` · `; Compact omits detail. |
| Not closed, without a running tool | Use the analysis label even when completed-tool counts are nonzero. Standard may append running reasoning detail. |
| Closed, zero categories | Use the completed-analysis label. |
| Closed, one category | Use its closed label without a count. |
| Closed, two categories | Join ranked labels with “and”. Chinese removes the second leading `已` only when both labels start with it. |
| Closed, three categories | Join all three ranked labels with commas. |
| Closed, more than three categories | Show the first three labels followed by “etc.” (`等` in Chinese). |

English lowercases the initial letter of joined labels after the first. Closing a group immediately selects the completed summary; the 150ms minimum applies to running-title changes, not to delaying completion. Detailed hides group headers in running Turns, including groups ended by a reply or steering before their Turn ends. Verbose also hides historical group headers.

Group headers show a category icon, replace it with a down arrow on hover or keyboard focus, and show an up arrow while open. Manually expanded group bodies use 8px row spacing, a `min(400px, 50vh)` height cap, and 24px directional fades. Wheel scrolling can continue into the outer transcript at an edge. Detailed removes the group-level cap and uses 16px row spacing in running Turns; Verbose applies this layout to historical Turns as well.

An open capped group follows content growth only while its own scroll position is at the bottom. Scrolling away pauses that group's following; returning to the bottom resumes it, independently of outer transcript following. Manually opening an unclosed group starts at the bottom and follows growth; manually opening a closed group starts at the top with following disabled, even when its initial content fits without scrolling. Closing the group in the data or restoring its height cap through a mode change does not reset an already-open reader's position. Browser find retains its own reveal position.

Individual reasoning starts collapsed, including while streaming. All modes preview the latest paragraph whose first line ends with a newline; an unfinished single line has no preview. Later text in that paragraph does not change the preview. After settlement, the mode table applies. Expanded reasoning uses compact Markdown typography.

Switching modes retains manually opened groups and inner disclosures. It changes visibility and sizing without recreating the message rows. Detailed and Verbose do not open every individual disclosure. Only Verbose keeps the whole Turn open.

-----

<a id="process-grouping"></a>
## Process grouping

[process-groups.ts](process-groups.ts) groups visible Chat content; [process-activity.ts](process-activity.ts) summarizes the activity inside each group. Both follow the rules below.

A group collects adjacent process content within one Turn. Step-number changes alone do not split it. All four modes use the same grouping result. A group's `closed` flag means its content segment has ended, not that its UI disclosure is collapsed.

| Input | Membership and segmentation |
|---|---|
| Non-blank Assistant reasoning | Append one `reasoning` reference for that Assistant to the current group, creating a group if necessary. |
| Assistant reply | End the preceding group and emit an independent `response` reference. If the same Node has reasoning, append that reasoning before ending the group. |
| `user`, `steering`, `turn-trigger`, `model-retry`, `turn-error`, `turn-max-tokens`, `turn-tail` | End the preceding group and retain the Node as an independent root. |
| `turn-process` | Retain the control as an independent root without ending the current group. |
| Other visible Nodes owned by a Turn, including tools | Append the whole Node to the current group, creating a group if necessary. |
| Node from another Turn or without a Turn | Break the same-Turn sequence. A Node without a Turn remains independent, including an unsplit Assistant. |
| Hidden Nodes, system prompts, ordinary Context injection, and `permission` commands | Excluded from the grouping input; they neither join nor split a group. |

A reply contains non-blank text, an image, or another visible block; reasoning and tool-call protocol blocks do not count as a reply. An Assistant with neither non-blank reasoning nor reply content contributes no reference. Group creation requires a member, so metadata-only Turns create no empty group.

### Examples

`A` denotes an Assistant Node, `T` a tool Node, and `G[...]` a process group. Arrows show input or root-reference order; examples share one Turn unless stated otherwise.

| Input sequence | Grouped roots |
|---|---|
| `A1(thought, reply) → T1` in one Step | `G[A1.reasoning] → A1.response → G[T1]` |
| `T1(step=1) → A2(thought, step=2) → T2` | `G[T1, A2.reasoning, T2]` |
| `T1 → steering → T2` | `G[T1] → steering → G[T2]` |
| `T1(turn=1) → U(no turn) → T2(turn=1)` | `G[T1] → U → G[T2]` |
| `A1(reply)` | `A1.response`, without a process group |
| `read → bash → subagent_codex` without an intervening reply or input | One group; changing tool category does not split it. |
| `run_code` with nested `read` and `bash` calls | One group member for the `run_code` tool Node; its nested calls do not create separate roots. |
| A tool receives a failed result | Update that member without splitting its group; a separate `turn-error` Node does split the sequence. |

Replies and independent separators close preceding groups immediately, even while the Turn is running. The final group also closes when another Turn or unscoped Node follows it, or when its Turn has status `closed`. Any other or unavailable Turn status alone does not close that trailing group. Regrouping after a separator disappears may reopen it.

-----

<a id="activity-summaries"></a>
## Activity summaries

[process-activity.ts](process-activity.ts) derives one group's category counts and live detail from its member Nodes. It does not decide membership or presentation text.

### Category counts

Counts describe calls in this group, not successful operations, files changed, child Agents, or elapsed work. The following rules apply before category ranking.

| Call evidence in this group | Counting rule |
|---|---|
| Preparing call, running call, successful result, failed result, or projected interrupted result with its original call | Count one call in the category selected by its recorded tool name. Settlement and failure do not add or subtract a call. |
| Repeated `callId` | Count only the first occurrence, including when it appears both as a root and as a nested call. Later occurrences and their subtrees are skipped. |
| Parent and child with different `callId` values | Count both, in their own categories; visit the parent before its children and siblings in recorded order. |
| Repeated calls to the same tool with different `callId` values | Count each call, even with identical arguments or the same terminal/session target. |
| Settled root result whose original call is missing | Do not infer its category from result text or metadata. Count no root call; its recorded subcalls still participate. |
| Assistant reasoning, Assistant tool-call protocol blocks, or another Node kind | Add no tool count. The separately projected tool Node owns that call's count. |

Deduplication is group-local. Counts sort descending; ties retain the category's first occurrence in member order and parent-before-child traversal. For `read → bash → read`, the ranking is `read=2, commands=1`; for `bash → read`, it is `commands=1, read=1`. No category has a fixed priority when counts tie.

### Tool-name classification

Classification uses the recorded tool name exactly: no case folding, namespace stripping, provider lookup, or inference from arguments. Names match the first applicable row below. All nonzero categories remain in the summary.

| Category | Tool-name match |
|---|---|
| `read` | `read` |
| `readImage` | `read_image` |
| `search` | `grep`, `glob`, or suffix `_inspect` |
| `write` | `write` |
| `edit` | `edit`, `apply_patch` |
| `commands` | `bash`, `pwsh`, `exec_command`, `write_stdin`, or prefix `terminal_` |
| `code` | `run_code` |
| `webSearch` | `web_search` |
| `webFetch` | `web_fetch` |
| `subagents` | `subagent` or prefix `subagent_` |
| `plan` | `todo_write`, `create_goal`, `update_goal`, `get_goal` |
| `questions` | `ask_user_question`, `request_user_input` |
| `tools` | Every other name, including `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` |

### Subagents, background jobs, and nested calls

A subagent tool follows ordinary group boundaries: it does not create a group merely because it delegates work. Its category describes the parent Session's tool call, not the number or lifecycle of child Sessions.

| Case | Category and activity behavior |
|---|---|
| `subagent`, `subagent_codex`, `subagent_claude_code`, or another `subagent_*` name | Count one `subagents` call per distinct `callId`, unless an earlier name rule matches. Provider and model choices do not change the category. |
| A configured name such as `subagent_inspect` | Classify as `search`: suffix `_inspect` is checked before prefix `subagent_`. The same precedence makes `terminal_inspect` a `search` call rather than `commands`. |
| Subagent controls `send_message`, `list_agents`, and `list_subagent_models`; job controls `job_output` and `job_kill` | Classify as `tools`, not `subagents`. Their business purpose does not override the name table. |
| A delegation tool renamed to a name outside the table, such as `research_agent` | Classify as `tools`, even if it invokes the same subagent provider. |
| Background subagent startup has returned its tool result, while the child is still running | Keep its category count, but remove that call from running-activity candidates. The child does not keep the parent's group in the subagent activity state. |
| Tool calls recorded only in a child Session | Do not include them in the parent group's counts or live detail. Only calls actually attached to a member's `subCalls` participate recursively. |

A `run_code` root counts once as `code`; its recorded PTC subcalls each count in their own categories. The wrapper is not replaced by leaf-call counts, and children are not all classified as `code`. With distinct call ids, `run_code → [read, bash, subagent_codex]` produces `code=1, read=1, commands=1, subagents=1`, in that tie order. A subcall can supply the live category while the outer `run_code` remains running.

Exact-name rules also mean that a recorded name such as `functions.read`, `mcp.read`, or `Read` falls into `tools`, while `browser_inspect` falls into `search`. A `terminal_*` name follows the command rule even when its operation only inspects or closes a terminal, unless the earlier `_inspect` rule matches.

### Live activity and detail

Preparing calls use their first named delta time; only the generic tool category provides the tool name as detail. Dispatched calls use their tool/call time and complete arguments.

Among running calls, the greatest `time` selects the live category and detail; equal times select the later visited call. With no running call, the category is absent and detail comes from the last nonempty reasoning paragraph of the latest running Assistant with nonempty reasoning, in member order. Reasoning detail removes `**` markers and does not require a newline-terminated first line; the individual reasoning-row preview has separate rules.

Live selection uses call start `time`, not the latest output/progress time. A call is a running candidate while its projected tool value has no result; pending approval or waiting for a result does not receive a separate category.

| Members' current state | Live category and detail source |
|---|---|
| `bash(time=10)` and `read(time=20)` both running | `read`, using the `read` arguments, regardless of which tool most recently emitted output. |
| The newer `read` settles while the older `bash` remains running | Return to `commands`, using the `bash` arguments. A failed `read` result has the same selection effect. |
| Running parent and child share the same start time | The child wins because it is visited later; later siblings win equal-time ties. |
| All tools settled; the group is not closed; a running Assistant has reasoning | No live tool category; use the latest nonempty reasoning paragraph as detail. |
| No running tool or usable running reasoning; the group is not closed | No live tool category and empty detail, even when category counts are nonzero. |
| A reply or another group boundary closes the group while a tool still lacks a result | Published live category and detail are cleared. Group closure takes precedence over the unfinished call. |

Tool detail uses the first nonempty supported argument field in this priority order: `title`, `description`, `objective`, `task`, `task_name`, `name`, `question`, `questions`, `prompt`, `message`, `command`, `cmd`, `queries`, `query`, `pattern`, `url`, `uri`, `file_path`, `path`, `target`, `action`, `status`. Strings and arrays consisting entirely of strings are supported; arrays join with `, `. The `questions` field instead selects the first nonempty `question` in its object array. Invalid, partial, or free-form JSON and arguments without usable detail fall back to the tool name.

The priority list is shared by every tool, not specialized per category. For example, `description` can override `command` on a shell call, and `title` can override a file path. The first field whose supported value remains nonempty after whitespace normalization wins; unsupported values are skipped.

| Tool and argument example | Resulting detail |
|---|---|
| `subagent` with `{"description":"Review parser","prompt":"Long instructions"}` | `Review parser`; the prompt is not appended. |
| `send_message` with `{"subagent_id":"child-1","message":"Check tests"}` | `Check tests`; its category is still `tools`. |
| `exec_command` with `{"cmd":"pnpm test","description":"Run focused tests"}` | `Run focused tests`; without a usable description, `pnpm test`. |
| `read` with `{"file_path":"src/app.ts","path":"fallback.ts"}` | `src/app.ts`; `file_path` precedes `path`. |
| `grep` with `{"pattern":"TODO","path":"src"}` | `TODO`; the searched path is not appended. |
| `web_search` with `{"queries":["React hooks","external store"]}` | `React hooks, external store`. |
| `web_search` with only `{"queries":[{"query":"React hooks"}]}` | `web_search`; object-array queries are not extracted recursively. |
| `web_fetch` with `{"url":"https://example.com"}`; `read_mcp_resource` with `{"uri":"resource://guide"}` | The URL or URI itself. |
| `request_user_input` with `{"questions":[{"header":"Scope","question":"Which package?"},{"question":"Which mode?"}]}` | `Which package?`; ignore headers and later questions once a nonempty question is found. |
| `run_code` with only `{"code":"print(1)"}` | `run_code`; `code` is not in the detail-field list. |
| `apply_patch` with raw patch text rather than a JSON object | `apply_patch`; no patch-path extraction. |
| Any tool with `{"description":" ","command":42,"path":"src/app.ts"}` | `src/app.ts`; whitespace-only strings and numbers are skipped. |
| Partial JSON, a JSON scalar, a mixed-type array, or only unsupported fields | Use the tool name if no other usable field exists. No partial-argument guessing. |

All live detail collapses whitespace, trims its ends, and is limited to 160 grapheme clusters, including a final `…` when truncated. A closed group's published summary clears its live category and detail while retaining category counts.
