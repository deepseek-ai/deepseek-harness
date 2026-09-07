# Agent Note: Web command business surfaces and assembly (ui-commands / ui-skill / ui-subagent)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-25-web-command-surfaces-and-assembly.zh.md)

> Scope: the command directory cache and three-kind dispatch (ui-commands), the popup selection flow, the two skill / subagent reference sources, and fixture command routing plus assembly acceptance (the slash-flow snapshot). The carrying wire lives in the [session scope note](2026-07-25-web-client-session-scope-and-provide-channel.md); triggers, the menu, and the input machine live in the [input machine note](2026-07-25-web-input-machine-and-slash-pipeline.md).

## Problem

The pipeline was ready but command knowledge had no landing spot: host-side `ctx.commands` and `ctx.skills` were complete while the web channel had no command capability. The business layer had to answer:

- Command UI takes more than one shape (execute on the spot, pop a select box, backfill and keep typing arguments) — how do business packages ship with zero skeleton changes;
- When is the directory fetched: pulling on every menu open is too slow, while a resident cache needs invalidation and reconnect stories;
- Sessions are always agent-backed (Session + Agent born in the same instant) — by what address does the client command surface honor the host's per-agent effective directory;
- Assembly-level acceptance: with the layers split apart, how the user-visible main chain is pinned once they come together.

## Decision

### ui-commands: a `CommandUiRuntime` + a session-keyed `CommandDirectory` + a per-session `PopupSelectController`

- The `ClientSessionContext { sessionId }` projection is self-held in the ui-input-trigger contract (types.ts): sessions are always agent-backed, so session identity is the entire projection of command capability; the wire addresses by `{sessionId}` (both `command.list` and `command.execute`; the host resolves the Agent from the session header).
- The directory is compartmented by `SessionId`, with per-key single-flight + an epoch guard (an old pull never overwrites newer state); `commands/changed` soft-invalidates every key (the old snapshot keeps serving while the repull runs in the background), `connection/reset` hard-invalidates every key and rewarms, Enter strong-waits on the current key, and a failure keeps the draft with no downgrade. Prewarming hangs on the source's `warm` hook — once over the full roster at scope birth, which covers the entire session lifecycle (session capability is constant from birth).
- `register(contribution)` registers client commands (a descriptor + `available(projection)` + a popupSelect spec); candidate synthesis = the host directory + contribution availability filtering, then the query/position pass, and a host/contribution name clash fails loud.
- The three command kinds derive from the registration surfaces; developers never declare positions: a host descriptor with `input` = **leadingInput** (backfill `/name ␣` + claim, keep typing arguments, leading position only); a client-registered popupSelect spec = **popupSelect** (the official select-box shell, business ships zero components); neither = **execute** (run on selection, zero UI).
- The dispatch decision table: the menu can trigger all three kinds; Space recognizes only leadingInput (the misfire defense: irreversible side effects keep explicit entry points only); Enter runs execute / opens the shell only on a bare token, while leadingInput tolerates trailing arguments.
- The popup from `popupFor(actx)`: search filters locally, select is single-flight, the projection is captured at open, onSelect consumes the token through the consume-token event only on success, a failure is retained for retry, and a session switch merely hides it. The popup shell is a transient layer (never in the state machine): the box holds focus, Enter/↑↓/Escape belong to it, and clicking outside the box dismisses (clicking the textarea also returns focus).

### Reference sources (seeing only projections plus their own apply closures, on the root ctx)

- **ui-skill**: `skills/list({sessionId})` addresses by session (the host resolves the project root from the session header); the directory cache is single-flight keyed by sessionId, prewarmed at birth by the `warm` hook and fully cleared by `connection/reset`. A pick produces a text outcome (the literal `/name ` text, the plain-text-reference decision); `lexicon` supplies the roster from CatalogFetch's settled snapshot (`undefined` while not warm), and `subscribeLexicon` notifies per-session listeners on settle and on invalidation. No match hook (references never enter command adjudication). Skill references ride ordinary prompts as literal text (outside the command plane; tool-skill unchanged, with the session-prefix directory providing the cooperative association).
- **ui-subagent**: candidates are zero-RPC (the sessions.list snapshot filtered by parentId/running); a pick produces a text outcome (the literal `@name ` text); `lexicon` derives from the same snapshot and `subscribeLexicon` forwards the list store's change feed (the model-side representation awaits its business workstream).

### Fixture command routing and assembly

- The connection fixture adds command routing (fixture + fake-api): the keyless rig can run the complete command flow (directory, execution, popup selection).
- The apps/cli assembly mounts all the new packages; the tsconfig path map / reference sets are filled in; catalogs/docs are regenerated with the wire and events.

### Assembly-level acceptance: the slash-flow snapshot

`apps/web/tests/slash-flow.snapshot.ts` pins the user-visible main chain (assembled keyless; package mocks are no substitute for the assembled transcript): the composer disabled with no session → creating a Workspace and entering an already-materialized blank session → picking the `/echo` leadingInput from the `/` menu → the command executes but the blank bit does not flip and the list still shows `New Session` → the first ordinary prompt's successful acceptance converts that same row; the same session-bound textarea holds across blank → active. `workspace-flow.snapshot.ts` separately pins blank-row creation/reuse, first-prompt rejection backfill, and — on a Workspace switch before the first prompt — the draft moving across input machines with the old blank row hidden.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Inline prompt dispatch (command text riding the message into the host for parsing) | Conflates the command and message planes; command execution being independent of the message queue is existing host semantics |
| A bridge materializing skills as commands | Skills have their own directory; N registrations would be a detour; the tag form naturally avoids the command plane |
| A `skill.invoke` RPC | The host has no such operation; skill references are plain text riding prompts |
| A new ContentBlock reference type | Full-chain cost (adapters/UI/compaction); text-as-truth plus structured occurrence records suffices |
| Client packages self-reporting command directories | The host is the single source of truth; the client only reads descriptors, with `commands-changed` pushing invalidation |
| The `requires: 'none' \| 'agent'` discriminant axis (an agentless directory + dual-addressed queries) | With sessions always agent-backed, the amphibious command has no owner; the whole axis is dropped, to be reopened on real demand |
| Dedicated commandresult / commandpanel slots | Results go through notices; the popup shell is a skeleton-internal overlay; rich result cards sit in the ledger |
| An agent-type directory as the `@` source | No type registry exists; the live-session snapshot already covers it |
| A PickAction/EnterCommand class family (class-inheritance pick products) | Cross-package runtime values break client bundle purity; pure data interfaces plus closure methods are equivalent |

## Consequences

- Shipping a business command = a host registration plus one client `command.register` (popupSelect) or zero registration (execute/leadingInput derive automatically), with zero skeleton changes; the cost is that the three-kind semantics concentrate in ui-commands, and a hypothetical fourth kind means changing it.
- The resident directory cache plus push invalidation buys zero-latency menus and reliable enter adjudication; the cost is three invalidation paths (the change frame, reconnect, the epoch guard) that all need tests pinning them.
- sessionId addressing puts the host's per-agent effective directory (global + scoped shadows) straight on the wire, with the client presenting it as-is.
- Known gaps: the popupSelect shell has no shipped business consumer yet (model selection and its kin arrive with the host `selectModel` work in live-mutation shape, serving as the onboarding template then); the queue's second cut (per-item Inbox operations), rich result cards, and roster configurability sit in the ledger awaiting their triggers.
