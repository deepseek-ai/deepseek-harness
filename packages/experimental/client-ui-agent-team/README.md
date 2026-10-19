---
description: "Inspect the experimental shared task board from the Web conversation header."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds a shared task-board panel to the Web conversation header. Host projection frames keep task state current without a refresh control. Ordinary subagent navigation owns the member list and teammate conversations. Choose this package through the experimental Agent Teams bundle; it adds no model-facing input.

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

In the root conversation’s model and reasoning menu, turn on **Use Agent Teams**. New Sessions default to off. The shared task-board action appears while enabled; members remain in the existing Subagent tree. Turning it off retains tasks and subagents. The switch waits for the saved projection and reports failures through the menu host.

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The read-only board shows task identity, owner label, blockers, readiness, advisory write scopes, and overlap warnings. Owner labels reuse existing Session and subagent catalog data, falling back to the Session id. Long descriptions can expand. The heading shows the task count and an empty board has a short explanation. Agents mutate tasks through tools; the panel provides no mutation controls. A projection failure appears above the last valid tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries and conversation-header and model-menu slots through Cordis effects; it mounts no Remote namespace. Disposing the plugin fiber removes its registrations.

The panel renders outside the conversation container and stays within the viewport. Hover opens it after 150ms; leaving the trigger and panel closes it after 120ms. Clicking pins the panel and moves focus into it. Outside clicks and Escape dismiss it; Escape returns focus when focus was inside. A narrow header uses an icon trigger that opens on click. The panel resolves the root through Session ancestry and reads its `agentTeam` projection. Incomplete ancestry or missing projection data leaves the board unavailable; conversation changes close the panel.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale and header-slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Projection-derived task board and panel interaction state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative task and projection behavior.
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

- **No mailbox timeline** — the panel displays tasks, not messages.
- **Late plugin activation** — after enabling Agent Teams in an already-open conversation, reload the page to receive its Team projection.
- **Missing owner labels** — unread Session or catalog metadata leaves an id label until ordinary loading supplies a description.
- **Member navigation is separate** — use the ordinary subagent header to open teammate conversations.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
