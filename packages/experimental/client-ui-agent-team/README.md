---
description: "Use and debug the experimental Web Agent Teams roster, shared task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header, where a user can inspect the current roster, inspect the shared task board, and navigate into a teammate's conversation. It reads the Lead Session's `agentTeam` projection from the shared Session store, where Host projection frames keep it current without a refresh control, and keeps ordinary child-history navigation on the stable addressed-subagent path. Choose it through the published experimental Agent Teams bundle. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

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

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

The panel shows the Lead Session's roster and task board from the shared Session store. Task and roster updates appear while the panel stays open. Opening the panel performs no projection requests. The panel shows a loading notice while the conversation or Session list is loading, and an unavailable notice when no Team value is present afterward.

Roster rows show durable names and phases. Provisioning and running members use the shared ongoing loader, inactive members use a person icon, and failed members use error. Live Session status supplies running activity; the shared `modelSelection` projection supplies a model when available. The current conversation carries a Current chat tag and cannot be selected. Selecting the Lead from a teammate conversation opens the Lead Session directly. Selecting an active teammate opens its ordinary continuable child address. The Host validates the parent, child, and mode when history opens; later human prompts use the same addressed-subagent conversation.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The read-only task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. Descriptions longer than two lines have an expand toggle. Section headings show member and task counts; an empty board shows a short description, and a lone member with no tasks uses a single-column panel. Team agents create and update tasks through their tools; the panel provides no task mutation controls. When the projection reports a rejected persisted Team record, the panel shows that failure above the last valid roster and tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries and one conversation-header slot through Cordis effects; it mounts no Remote namespace. Disposing the plugin fiber removes both registrations.

The panel renders outside the conversation container and stays within the viewport. Member cards use the shared elevation stroke for their outlines in resting, selected, and hover states. Hovering the trigger opens the panel after 150ms; leaving both trigger and panel closes it after a 120ms grace period. Clicking the trigger pins the panel and moves focus into it. Outside clicks and Escape dismiss the panel; Escape returns focus to the trigger only when focus was inside the panel. In a narrow header, the trigger becomes an icon and opens only on click. The component derives every row from the `useSessions`, `useSessionStatus`, and `useSession` seats: the Lead identity comes from the current Session's subagent address, the Team view from `projectionsBySession[lead].values.agentTeam`, member activity from Session status with the list summary as fallback, and the model from `projectionsBySession[member].values.modelSelection.next`. Each roster row selects its own running state. The only injected callback opens a roster Session using the current and target Session ids. Switching conversations closes the panel and clears a navigation failure.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Projection-derived roster and task board with panel interaction state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, and projection behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No mailbox timeline** — the projection view carries roster and tasks only; peer messages are not shown.
- **Late plugin activation** — after enabling Agent Teams in an already-open conversation, reload the page to receive its Team projection.
- **Model availability** — a model appears only when the shared store has a durable selection or request for that member. Missing cold-cache values stay absent until normal Session loading or a live update supplies them.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The Host projection is authoritative and the package owns only one disposable slot registration.
