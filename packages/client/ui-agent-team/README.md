---
description: "Inspect the shared task board from the Web conversation header."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package displays shared tasks below the Subagent tree in one header panel. Host projection frames keep task state current without a refresh control. Ordinary subagent navigation owns the member list and teammate conversations. The Web bundle loads this package; it adds no model-facing input.

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

In the root conversation’s model and reasoning menu, turn on **Use Agent Teams**. New Sessions default to off. While enabled, open the Subagent control to see members above shared tasks. The same control remains available before the first member exists. Turning it off retains tasks and subagents. The switch waits for the saved projection and reports failures through the menu host.

The [Web bundle](../../bundle/web-app/README.md) loads this package by default. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The read-only board shows task identity, owner label, blockers, readiness, and advisory write scopes. The root owner is labeled Lead; other owners use the subagent catalog label, then the Session title, then the Session id. Long descriptions can expand. The heading shows the task count and an empty board has a short explanation. Agents mutate tasks through tools; the panel provides no mutation controls. A projection failure appears above the last valid tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries and subagent-catalog and model-menu slots through Cordis effects; it mounts no Remote namespace. Disposing the plugin fiber removes its registrations.

The Subagent catalog owns the shared panel, scrolling, hover, keyboard, and dismissal interactions. This package contributes the task section below the tree in root and descendant entries. The board resolves the root through Session ancestry and reads the mode and tasks together from its `agentTeam` projection. It appears only when that projection is available and enabled.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, catalog-section, and model-menu registrations |
| [`src/client/TeamBoard.tsx`](src/client/TeamBoard.tsx) | Projection-derived task section |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web bundle](../../bundle/web-app/README.md) — mounts the Client plugin by default.
- [Agent Teams service](../../subagent/agent-team/README.md) — authoritative task and projection behavior.
- [Conversation UI](../ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No mailbox timeline** — the panel displays tasks, not messages.
- **Missing owner labels** — unread Session or catalog metadata leaves an id label until ordinary loading supplies a description.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
