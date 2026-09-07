# Agent Note: Durable workflow runs in Chat

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-durable-workflow-runs-in-chat.zh.md)

## Problem

The ordinary workflow tool row owns the model call and final tool result, but those two records do not explain which members actually started, how they were grouped, whether each member completed, failed, or was cancelled, or what remained unfinished when a process stopped. Live `workflow/*` events expose those facts only inside the current process, so a refresh or later Session open loses the run history.

The Web Client already assembles business-owned Conversation Nodes from durable Session events. Workflow history therefore needs a producer that can correlate one accepted run with its calling Session, a minimal durable protocol that remains meaningful as a prefix, and an independent renderer that does not take ownership away from the existing tool card.

## Decision

`dsh-tool-workflow` projects every top-level accepted run into the calling Agent's Session. `tool-workflow/run-start` records the stable `runId` and validated name; matching workflow member events record the member sequence, exact label, optional exact phase, child Session id, and outcome; `tool-workflow/run-end` records the stop reason only after the result exists and `run.dispose()` has reached quiescence. Nested transport executions run normally but write no workflow record because they do not own an independent Chat row.

Recording is observational. The first failed Session append disables all later writes for that run, logs one warning, and never changes cancellation, result mapping, or disposal. Each possible failure leaves either no record or a legal continuous prefix: a started run may lack later members or its ending, and a started member may lack its ending. The package invariant rejects duplicate run starts, invalid or reused positive member sequences, unpaired or repeated member endings, a run ending while members remain open, and every update after a run ending on both cold load and live append.

The workflow package exposes browser-safe run and observation vocabulary through `@deepseek-ai/dsh-workflow/types`; live `Agent` requests and control handles remain Host-only. `@deepseek-ai/dsh-tool-workflow/types` owns the four Session events. Client code imports only these type faces, so the Host and Client TypeScript programs share the durable contract without merging Host Cordis context.

`ui-workflow-run` registers one `workflow-run` Conversation Definition and one keyed Chat renderer. Every event independently yields the same `runId`; run-start initializes State, later events update it in log order, and an update-only history tail remains pending until prepend supplies the unique start. The final node keeps the engine-owned key and anchors at run-start, placing it after the original tool call while preserving one React parent from running through terminal state.

The renderer gives each level a distinct visual responsibility. The run uses a 32-pixel module-platform background row with persistent right/down chevrons and an inline state dot plus status text, without a badge. Phases use 32-pixel disclosure rows with title and member count in the flexible main area and a fixed precise aggregate-status tail, without another dot. Members use a 16-pixel dot slot, a truncating name area, and a fixed 64-pixel status column. Phases exist only when a member actually starts and group by the exact phase string; an omitted phase and the empty string retain distinct identities and localized names. Member settlement changes status without removing or reordering the member. A closed Turn or Step turns missing run or member endings into interrupted presentation; a durable ending remains authoritative when present. [Status-driven workflow disclosure](2026-08-11-workflow-run-status-driven-disclosure.md) owns which run and phase content remains visible as those facts change.

Navigation is derived from two current authorities rather than persisted. A member row is interactive only while its durable member state is running and the current ordinary Session list contains the same id with `origin: 'subagent'`, `parentId` equal to the displayed parent, and `running: true`. Underlined member text is the only visible affordance; keyboard focus draws a two-pixel business-primary ring around the name area, and the fixed status label remains the lifecycle word rather than an action instruction. The renderer invokes only the injected ordinary `sessions.open(id)` callback. Addressed-only, remote, wrong-parent, and terminal members remain visible but static.

The [seven-state Figma reference](https://www.figma.com/design/tguwzZRmHCjbq58mfsqT0M?node-id=5-2) fixes the information hierarchy for running expanded/collapsed, completed history/expanded, failed plus cancelled, interrupted recovery, and dark narrow presentation. Repository `DisclosureRow`, `StateDot`, icons, semantic tokens, and keyed-node behavior remain the implementation authority; the reference introduces no runtime field or state owner.

## Verification

Package tests cover top-level and nested eligibility, zero-member and concurrent runs, disposal-before-ending order, all four append-failure prefixes, and cold/live invariant rejection. Conversation tests compare complete replace, update-only prepend, and live append; they cover exact phase identity, terminal and interrupted status, disclosure state, list-fact navigation, and HMR removal and re-registration. The shipped Web replay uses the existing workflow parent and child model fixtures to exercise the real worker, spawn provider, Session persistence, browser bundle, running child navigation, terminal retention, original tool-row coexistence, narrow dark tokens, and refresh reconstruction.

## Alternatives considered

**Append workflow content inside the existing tool card.** Rejected because `ui-tool` and the tool definition own that row's presentation and interaction. A workflow-specific appendix would couple two independently keyed business lifecycles and revive the removed post-tool attachment model.

**Persist a server-side projection or add a workflow wire channel.** Rejected because Session events already provide persistence, live delivery, pagination, and gap repair. Another service, cache, or transport would duplicate the same facts and create a second lifecycle owner.

**Render declared phases or infer a static workflow graph from script text.** Rejected because only member-start events prove work happened. `meta.phases`, `phase()` narration, branches, and script syntax do not describe one authoritative runtime topology.

**Keep terminal child navigation.** Rejected because the workflow record proves historical identity, not current accessibility. Cold or remote Session opening needs a separate catalog and authorization contract; this node grants no such promise.

## Consequences

Workflow progress survives refresh and process recovery in the same log as its parent conversation, while execution ownership remains with the workflow run holder and the original tool card remains unchanged. The durable protocol adds four small events and one package-owned invariant; first-write failure intentionally sacrifices later observation rather than workflow correctness. Browser State is derived per loaded window, the status-driven disclosure lifecycle keeps review choices local, and navigation can disappear as list facts change. The design shows only actual runtime members and statuses, giving up static graph visualization, outputs, logs, controls, and terminal-member opening.
