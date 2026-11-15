---
kind: upgrade-guide
description: "Background jobs, subagents, and forge change requests move from the Session header and right sidebar into the Session panel, which removes the subagent footer slot and retires the forge tab type."
---

# Session header entries move into the Session panel

English | [中文](guide.zh.md)

## Change

The Web and Desktop Session header used to show a background-jobs button, a subagents button whose menu ended with the `conversation.session.header.actions.subagent.footer` slot, and, with the forge bundle, a change requests button that opened the `forge-panel` right-sidebar tab. These entries now live in the [Session panel](../../../../packages/client/ui-session-panel/README.md) that the header toggle opens:

- [`dsh-client-ui-jobs`](../../../../packages/client/ui-jobs/README.md) and [`dsh-client-ui-subagent`](../../../../packages/client/ui-subagent/README.md) register Background jobs and Subagents sections; the subagent footer slot is removed, and the shared task board that filled it is now its own Shared tasks section.
- [`dsh-experimental-client-ui-forge`](../../../../packages/experimental/client-ui-forge/README.md) registers a Change requests section, checkout and local changes rows in the Environment section, and an attention mark on the toggle. It no longer registers the `forge-panel` tab type, its tab title, or a `conversation.session.header.utilities` entry; the changes view keeps its `forge-changes` tab type.
- In the forge changes extension API, `ctx.forgeChanges.kinds` keeps only `changes`, because `panel` named the retired tab type; the `forge.change-request.card.actions` slot keeps its owner props and renders on each card of the Change requests section, before the card's actions menu.
- Type exports follow the components: `JobsSection*` replaces `JobListAction*`/`JobListInjected`, `SubagentsSection*` replaces `SubagentCatalogAction*`, and the forge `ChangeRequestsSection*`, `ChangeRequestsActions*`, `CheckoutRow*`, `LocalChangesRow*`, and `AttentionIndicator*` types replace `ForgeTab*`, `HeaderButton*`, and `LocalChangesCardProps`.

Client plugins and runtime extensions that register into the old footer slot, open the `forge-panel` tab type, read `ctx.forgeChanges.kinds.panel`, or import the removed types are affected. A right sidebar restored with a `forge-panel` tab no longer shows that tab. Session data and configuration keys are unchanged.

## Migration

1. In Client plugins and runtime extensions, replace every `conversation.session.header.actions.subagent.footer` registration with a `conversation.session.panel.section` registration that has its own `id`, `order`, and `label`, and remove child declarations of the old slot.
2. Replace calls such as `ctx.sidebarRight.openTab('forge-panel')` and reads of `ctx.forgeChanges.kinds.panel` by asking the user to open the Session panel; to place content beside the change requests, register a `conversation.session.panel.section` entry, as the [Session panel README](../../../../packages/client/ui-session-panel/README.md) describes.
3. Update type imports to the names listed under Change.
4. Confirm the migration by running `pnpm run typecheck`, then opening a Session in Web, clicking the Session panel toggle in the header, and finding the content in its own section.
