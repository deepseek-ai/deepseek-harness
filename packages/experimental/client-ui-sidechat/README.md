---
description: "The /side command forks the conversation at its latest completed Turn into a side conversation in the right Sidebar, as an optional experimental plugin."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-sidechat

English | [中文](README.zh.md)

## Summary

Add the **/side** command to the composer. It forks the conversation at its latest completed Turn through the ordinary Session fork and opens the child as a tab in the right Sidebar of the conversation on screen, with the Chat view, composer and message actions. The child Session records `origin: 'side'`, so the left sidebar does not list it. Default profiles do not install this plugin.

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

Add the plugin to an initialized Web profile:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-client-ui-sidechat
```

The [patch](cordis.patch.yml) adds the `ui-sidechat` row after the Web layers; it has no configuration. Remove it with `dsh plugin --profile web remove @deepseek-ai/dsh-client-ui-sidechat`; created Sessions remain available through ordinary history.

**/side** appears in the composer's command menu and is always consumed as a command, so a typed `/side` never reaches the model as a message. It forks with the ordinary fork's omitted cut, so the Host selects the latest completed Turn and the standalone events after it; a running Turn stays with the source. The Host refuses a conversation without a completed Turn, such as a blank Session or one still in its first Turn, which the plugin reports as having no completed turn. A subagent conversation reports that it cannot start a side conversation: its child would inherit the delegated approval policy and preset without the delegation itself. Each `/side` creates its own side conversation. The side conversation opens as a tab in the right Sidebar of the conversation on screen; `/side` inside a side conversation adds the new child beside it rather than inside it. **Branch into a new conversation** keeps its existing behavior and navigates the main area to the child.

The side tab shows the child's live title with the branch glyph and renders the Chat view with its composer and message actions, like the subagent Sidebar chat; it has no Session header or view switch. The child receives a numbered title like an ordinary fork. Closing the tab closes only this window's tab; the Session and its history remain stored, but the left sidebar does not list them. Saved tabs reopen after reload; a tab whose Session can no longer be retained shows a failure message in place.

A failed creation shows a transient notice at the top of the window; the source conversation stays unchanged. A child whose numbered title could not be set still opens.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) is the inert Host discovery entry; the plugin adds no Host service, Remote or Session event. The [Client entry](src/client/index.ts) registers the `/side` command through `commandUi`, the root failure notice in `shell.overlay`, the `sidechat` resource provider, the `sidechat` Sidebar tab type and its body and title. The [control](src/client/control.ts) calls `sessions.fork` without a cut and with `increaseTitle`, then `sidebarRight.openResourceIn` for the Session that was on screen when the user asked; a released main Session store makes that open a no-op while the child remains listed. The [resource provider](src/client/resource.ts) retains the child Session with its `conversation` facet for the tab's lifetime and yields a failure frame for malformed addresses or acquisition failures. The [tab body](src/client/views.tsx) binds the retained reference through `SessionProvider` and renders the `conversation.content` Factory from [`ui-conversation`](../../client/ui-conversation/README.md) in its `embedded` variant with a fixed Chat view and no Hero.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication and isolation policy.
- [Conversation UI](../../client/ui-conversation/README.md) — the `conversation.content` Factory the side tab renders.
- [Right Sidebar](../../client/ui-sidebar-right/README.md) — tab types, resource addresses and the saved window layout.

-----

<a id="model-experience"></a>
## Model Experience

None, as this plugin adds no model-facing input: the child is an ordinary fork whose inherited prefix the Session fork already records.

#### KV Cache effect

None; the package does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Window-local tabs** — open side tabs are part of this window's saved Sidebar layout; another window connected to the same Host does not show the child.
- **No way back from the left sidebar** — the child header records its source as `parentSession`, but the left sidebar does not list side conversations; once its tab is closed, nothing there reopens it.
- **Lost fork response** — if the fork response is lost after the Host created the child, the child remains stored without an open tab or a left sidebar row, and the notice reports a failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
