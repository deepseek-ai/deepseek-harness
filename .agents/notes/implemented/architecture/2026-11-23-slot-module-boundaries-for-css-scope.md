# Agent Note: Scope slot styles to the package that supplied the content

Status: implemented

English | [中文](2026-11-23-slot-module-boundaries-for-css-scope.zh.md)

## Problem

Package A uses the `Tree` Component Factory from B and supplies a button for `tail`. A wants its button rules to stop at B's tree but apply again to its own button inside the tree. Package C can fill the same `Tree:tail` with its own button. The position is the same in both calls; the package that supplied the content is not.

## Decision

Client stylesheets remain global by default. To test isolation for one dynamically loaded Client plugin, built-in or external, an operator sets `__unstable_enable_client_isolation` on its [Loader entry](../../../../packages/client/modules/README.md#script-isolated-packages) in `cordis.yml`. `style` and `scriptandstyle` restrict that package's own compiled stylesheets, not its dependencies' sheets. `script` selects only a JavaScript Realm.

Each module record carries its owning package's isolation declaration at load. The [stylesheet installer](../../../../packages/client/ui-renderer/src/client/styles/document-styles.ts) uses that record to decide whether to wrap its CSS. On [existing Slot roots](../../../../docs/subsystems/slots.md#slot-style-ownership), `data-plugin` identifies the actual supplier, not a display name or a CSS setting. Unknown suppliers and framework errors use an empty name; a shared list outlet carries no package name.

The installer wraps each selected stylesheet in native `@scope`, quoting its package name as a CSS string. For example, `pkg-a`'s button rule becomes:

```css
@scope ([data-plugin="pkg-a"]) to ([data-plugin]:not([data-plugin="pkg-a"])) {
  .probe { padding-left: 11px; }
}
```

A scope excludes its limit element and the branch below it. Another marked root for A is *not* a limit for A: a selector anchored to the outer `:scope` can still reach it. The path ends at a root for another package or an unknown supplier, even if that package uses global CSS. Inside B, a new A root can start A's stylesheet again, but cannot reconnect a selector anchored to the outer A. Use `:scope` to match the root itself.

Unscoped stylesheets are installed unchanged, so an unscoped theme can still match content in every package. Package names in the DOM do not indicate which stylesheets are scoped.

### A → B → A in a Factory

Suppose A supplies `panel`, a `single` slot, and calls B's `Tree` there. The Factory uses a block root; its `tail` local declares `inline: true`. The DOM is the same whether the packages opt in or not. The structure, omitting `display: contents`, is:

```html
<div data-slot="panel" data-plugin="pkg-a">
  <button class="probe">A1</button>
  <div data-slot-factory="Tree" data-plugin="pkg-b">
    <button class="probe">B</button>
    <span data-slot-factory-children="Tree:tail" data-plugin="pkg-a"><button class="probe">A2</button></span>
  </div>
</div>
```

A's rule matches A1 and A2, not B's button. If B does not opt in, its root still stops A. If C selects the `tail` component instead, the local root keeps `Tree:tail` but names C. A default local stays in B's scope without a local root. A registered Factory or mounted replacement that returns `null` keeps its empty root; binding a replacement without mounting it creates none. Removing a definition removes the Factory root, unlike an ordinary retained slot outlet whose declaration has been removed.

Permission to render a child slot is separate from who supplies that call's content. If A's selected local uses `renderSlot` for a child declared by B's Factory, the renderer checks B's declaration but attributes A's supplied children or fallback to A. [Component Factories](2026-09-10-component-factories-and-local-slots.md) own the declaration and selection rules.

### Two ways to forward HOC children

In a higher-order component (`hoc`) slot, the outlet around `{children}` names the supplier of what it contains, not the layer forwarding it.

**Two layers of one slot.** A passes Save to `frame`. B wraps C, and C wraps A's button; each layer adds its own button before rendering `children`. Both children outlets carry the name `frame`, but they do not start the same package's scope:

```text
[data-slot="frame"][data-plugin="pkg-b"]
├─ button#b-extra
└─ [data-slot-children="frame"][data-plugin="pkg-c"]
   ├─ button#c-extra
   └─ [data-slot-children="frame"][data-plugin="pkg-a"]
      └─ button#save
```

**One layer in each of two slots.** Here B alone wraps `outer.frame`, so the children B receives are A's Save button. B adds its own More button and hands both to `inner.frame`, whose only layer, C, returns them unchanged:

```text
[data-slot="outer.frame"][data-plugin="pkg-b"]
└─ [data-slot="inner.frame"][data-plugin="pkg-c"]
   └─ [data-slot-children="inner.frame"][data-plugin="pkg-b"]
      ├─ [data-slot-children="outer.frame"][data-plugin="pkg-a"]
      │  └─ button#save
      └─ button#more
```

C returns the group assembled by B. More stays in B; Save keeps A's original outlet inside that group. A shared compiled layer chain therefore takes the terminal supplier from each call, not the first caller. A layer that drops `children` renders no children outlet; forwarding empty content leaves an empty one. A crashed layer falls back to its marked inner content. [HOC layers](../../../../docs/subsystems/slots.md#hoc-layers) retain their own error and remount rules.

### A list with mixed suppliers

Inside an A root, suppose unisolated P and isolated A each win one `tools` row. P's `[data-slot-item][data-plugin="pkg-p"]` stops A on P's branch. The shared `[data-slot="tools"]` has neither module attribute, so a rule anchored to the outer A can still reach A's item. This stays true with only one winner, including `{ only: 'actions' }`. The winner's item groups text, a Fragment or empty output just as it groups a button.

Reordering siblings or switching between the full list and `only` does not remount the item or its controls while the same registration stays selected. Filtering it out or replacing its registration ends that lifetime. With no matching `id`, the caller's fallback sits directly inside the outlet and the outlet names the caller. With an exhausted `id`, the direct error element belongs to the framework instead. [List item roots](../../../../docs/subsystems/slots.md#list-item-roots) specify the tags and empty cases.

## Alternatives considered

**Infer the package from a slot name or the closest outlet.** `Tree:tail` identifies the same position for A and C. Both forwarded buttons can have the same nearest `inner.frame` but belong to different packages. One dispatch result determines the content and its marker; looking up a name or rerunning a chain selector cannot establish who supplied the content.

**Add a wrapper or require components to forward attributes.** The renderer already has elements at the handoffs, including list items for text, Fragments and `null`. Another element would change direct-child and sibling selectors. A component returning text has no element of its own to mark.

**Mark the occupied list outlet instead of the item.** One package name cannot represent several suppliers. Even an empty `data-plugin` would cut the path from outer A to A's item beside P. Marking the same item in both list modes preserves its ancestry and local state.

**Use Shadow DOM for two-way isolation.** That would change how host themes and shared rules reach plugin content. The requirement concerns where one package's selectors match, not a separate document or security boundary.

## Consequences

Only the selected package needs its selectors reviewed. For example, if its dark-mode rule depends on `body` outside the scope, use an inherited theme variable or put the relevant state on its own content. A scoped host cannot style a different package's row by writing a longer selector: put the layout on a host-owned element or agree on a shared rule. Opting in one built-in package does not require changing other built-in packages or global themes.

`@scope` does not stop inherited values (including fonts, colors and custom properties), isolate resource names, or change JavaScript execution. Scope proximity can break a tie in the cascade. A Portal follows the physical DOM at its destination: a portal into an unmarked `body` does not carry A's scope from its React parent. Arbitrary JSX moved through props and direct component imports do not establish package ownership either.

Styles follow the [module's lifetime and dependency order](2026-11-05-client-module-metadata.md), not a component mount. A loaded entry and its later chunks retain their declaration; a replacement package registers with the graph then in use. New Slot registrations identify the supplier only. A sheet the destination document cannot parse as native `@scope` is reported and omitted, never installed globally.

## Verification

**Built Web application.** The [Chromium integration test](../../../../apps/web/tests/client-style-scope.e2e.ts) compares non-inherited properties on A → B → A. Global CSS gives all three probes 7px of padding; B’s scoped sheet gives left margins of 0/23/0px. When the Host selects global styles, the loaded package keeps its original sheet and button state, and its later chunk uses the same setting. A fresh page or rebuilt package installs global styles from the newly loaded records.

**Renderer and installer regressions.** The [DOM ownership tests](../../../../packages/client/ui-renderer/tests/module-anchors.client.spec.tsx) cover retained list controls across `only`, HOC forwarding and crash fallback, different callers of the same Factory local, and neutral error elements. The [stylesheet tests](../../../../packages/client/ui-renderer/tests/module-styles.client.spec.ts) cover producer caching, global dependency styles, same-path conflicts and sheets that cannot be scoped.

These checks do not establish cross-browser behavior, restyle cost or host layout for every package. When opting in a host, measure the control, not its boxless [list item](../../../../docs/upgrade-guide/v0.2.3-alpha.2/list-item-roots/guide.md): for example, the [Session panel dot](../../../../packages/client/ui-session-panel/src/client/SessionPanelToggle.module.css) is 6px, the [last settings row separator](../../../../packages/client/ui-settings-general/src/client/GeneralSection.module.css) depends on which rows have content, and an [empty files action row](../../../../packages/client/ui-sidebar-files/src/client/FilesBody.module.css) must not open a gap.
