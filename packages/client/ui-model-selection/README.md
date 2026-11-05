---
description: "Model selection for the Web GUI: the /model popup and the composer model seat over one per-session provider-grouped directory; for users and maintainers of model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

The Web GUI lets users switch the model and reasoning effort for an existing session through either the `/model` popup or the composer's model control. Both surfaces present the same provider-grouped choices, and the selected model determines the available effort names and default. A complete selection applies to the next request; a running step keeps the model and effort it started with.

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

DeepSeek account and API-key routes appear as separate provider groups, each exposing the same configured model catalog.

When no model is selected or the saved selection is absent from the catalog, the composer shows “Select model” in regular weight and hides the reasoning effort caption. Clicking it opens the model list directly; Escape closes it. Tab and Shift+Tab traverse its controls and leave the menu at either end. An empty catalog hides the model menu from display and the accessibility tree and displays “No models available.” in a status region.

Mount this plugin alongside `ui-conversation` and the commands package; the composer then shows the model seat next to the pending indicator, and `/model` opens the same directory as a popup. In the root menu, `↑`/`↓` move between the model row, reasoning slider, and contributed options. A focused slider keeps arrow, Home, and End keys for its own value; Tab and Shift+Tab move to the adjacent control. In model search, arrows move the highlight and Enter selects it. Tab and Shift+Tab traverse search, its clear button, and the highlighted model without selecting; focused buttons activate with Enter or Space. Detail pages have no visible title or Back button. Escape returns to the root and restores the invoking row's focus; pressing Escape again closes the menu and focuses its trigger. Returning from the model list with Escape or after a successful model selection restores focus to the root model row without its grey background. Subsequent pointer movement or Tab navigation restores normal hover and focus styling. Phones and tablets leave model search unfocused until the user taps it or uses keyboard navigation. Removing a model or provider, including sign-out, preserves the saved route and effort without displaying their IDs; restoring its catalog entry restores its name and caption.

Mouse selection uses native browser clicks, including their cancellation behavior; a press alone never selects. Opening the root menu focuses its trigger, and clicking the trigger again closes it. Selecting a model returns to the root menu and its model row; changing effort does not move focus or change the current menu page. While a model selection is pending, the trigger and chosen model-list row show spinners. Pending selections retain their target value and block duplicate submissions without a loading cursor; effort-save completion preserves any page or focus the user navigated to while saving. A rejected selection leaves the menu and previous selection available for retry. Settings detail pages retain native Tab traversal.

### Model and effort

The button's model menu shows search only when its full catalog contains more than four models; smaller catalogs support keyboard navigation directly and focus the current model or first enabled row on all devices. The `/model` command always keeps its search field. Both search fields match model names case-insensitively, including nonconsecutive characters in order; leading and trailing spaces are ignored. Within each provider, prefix matches come first, followed by alignment score and then catalog order. Empty groups are hidden. Empty catalogs and queries without matches are announced through a status region. Search keeps focus while arrow keys cycle the highlighted result across provider groups. In the composer menu, Enter selects the result and Tab moves focus without selecting it; the `/model` popup retains its command-menu keyboard behavior. Left and right arrows keep their native caret behavior. Opening highlights the current model or the first available row, and editing the query resets the highlight to the first result. Reopening the model pane clears the query.

Model names use weight 400 (regular); the current effort tag uses weight 500. The search field follows the command popup's compact treatment with transparent background and border in both palettes, with no leading icon and a caption-tone placeholder. Its text is 16px on devices with a coarse primary pointer to avoid Safari focus zoom; fine pointers retain 12px. The clear button appears for a nonempty query and restores the full list with focus in the search field.

Both entries group models by provider, with DeepSeek Account first and DeepSeek second; third-party providers retain their catalog order. Both use the shared, asynchronously observed sticky headings from [ui-primitives](../ui-primitives/README.md#understand-the-implementation): transparent at rest, with the theme's 94%-opaque fill only while pinned, and `md` corners outside macOS Desktop. The composer menu shows model and effort names only. Navigation chevrons use `--dsw-alias-menu-icon`. The `/model` popup shows provider names as group headings and model names as rows, without repeating the provider on each row or showing catalog descriptions. Its search placeholder, no-match text, and empty-catalog text use the same localized labels as the composer model menu. The popup applies the selected model's default effort; the composer can then choose any advertised effort. An adapter without reasoning metadata leaves the reasoning slider absent; there is no arbitrary effort input.

The composer replaces the model and effort text with the Models icon when the expanded controls cannot share one line, and restores the text when space permits. The full selection remains available in the trigger's accessible name, tooltip, and menu.

The 260px-wide root menu places the model name above a centered, arrowless effort tag and a native slider with discrete stops for the exact model's ordered reasoning choices. The tag displays the complete localized label, such as “Effort: High”, and keeps its hover tooltip. It uses the default cursor, its text cannot be selected, and the label adds no Tab stop. Pointer drags preview locally and submit once on release; keyboard adjustments submit on key release. Escape during adjustment cancels the preview, and changing models discards any unfinished gesture.

The tag shows “Effort: Default” for the localized “Default” stop, which appears only when the adapter has no configured default effort. It submits no explicit effort: model and configuration defaults apply, which does not mean reasoning is off. Only this omitted-effort choice shows a keyboard-focusable information button beside the tag; a provider level with the explicit ID `default` does not. A single supported stop is readable but not draggable. No arbitrary token budget is entered here.

Standard levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`) use localized names only when the provider's name matches its ID ignoring case. Custom names and unknown levels remain unchanged; for example, `high` named “Thorough mode” keeps that name. This changes display text only, not submitted or persisted IDs.

The visual thumb and filled track follow pointer movement continuously during a drag; the native range still determines the discrete label and value, with one submission on release. Hovering the thumb with a fine mouse pointer or pressing the slider enlarges only the blue center of the visual thumb; the white disc and hit area keep their size. Mouse hover enlarges only the nearby tick, not neighboring ticks, and is inactive during dragging or saving. Touch interaction leaves no hover highlight. Reduced motion disables position transitions and center and tick enlargement.

### Model label extensions

`conversation.input.model.label` is a session-scoped, inline `single` slot for the composer trigger (`placement: 'trigger'`), the root menu's current value (`'menu'`), and each model option (`'option'`). Its owner props provide `provider: { id, name }`, the exact catalog `model`, `placement`, and `selected`. Provider names are localized display names; match channels by `provider.id`, and identify a model by the provider/model ID pair. Connection URLs and credentials are not passed to the slot.

Contributions must render non-interactive inline content, such as a colored name or badge. The selector owns clicks, search, focus, disabled states, check marks, reasoning effort, and trigger accessibility text. An absent contribution, including after plugin disposal, displays the catalog name with its optional `model.badge` before the name in the trigger and after it in menus: a `Tag` in the badge's tone whose text is resolved for the active locale. Long catalog names ellipsize within the available width while the badge remains visible. A contribution replaces both and receives the badge in its owner props. The trigger and root-menu value use the slot only when the selected model is present in the displayed catalog; otherwise they keep the built-in placeholder. During refresh, retained catalog entries continue to use the slot. The composer menu uses CSS anchors to follow its trigger and label size changes within the layout viewport. Pinch zoom scales the menu with the page; it may extend beyond the visual viewport, including while the keyboard is open. `/model` command rows use the command popup's separate rendering API.

Import this package's `/client` declarations type-only, then register through `ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({ name: 'conversation.input.model.label' }, ModelLabel))`. Derive `ModelLabel` props from `PropsRuntime<'conversation.input.model.label'>`; use provider IDs to choose CSS Module classes and retain `model.name` as the text. Registration follows the declaration and contributing plugin lifetimes. Without a component replacement, styles can target the enclosing label's `data-provider-id` and `data-model-id` attributes in all three placements.

### Unroutable sessions

Catalog availability does not block sending with a saved selection; request execution reports missing credentials or unavailable models. Refreshes and refresh failures retain the last displayed selection and groups. A Host reset clears that display. Sign-out hides the account provider from the picker while preserving the saved provider/model ID and reasoning effort. Signing in restores the catalog name when that model is available again. Existing session logs remain unchanged.

### Selection failures

When another writer owns the Session, model-selection failures tell the user to quit other running DSH instances and retry.

The session-scoped `conversation.input.model.options` list slot appends root options below model and reasoning controls. Its owner props expose `locked`, required `pending: boolean`, `reportFailure(message)`, `dismiss()`, and `openPage({ key, title })`. A root option marks its button with `data-model-menu-page` equal to its registration key and opens that key in `conversation.input.model.page`, a session-scoped keyed slot. The menu owner supplies scrolling, Escape navigation, focus return, and an accessible page name from `title`, without a visible title or Back button; the page receives `locked`, `pending`, `reportFailure`, and `dismiss`, while its owning plugin retains all settings and confirmation logic. Both slots distinguish an actual composer lock (`locked`) from a model or effort save in flight (`pending`); saving alone does not set `locked`. `dismiss()` closes the entire menu and focuses its trigger before another overlay opens.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Menus use the shared `MenuSurface` material, including the macOS backing for background blur; custom content follows the [menu rules](../../../docs/web-styling.md#component-rules). The composer menu uses a fixed body portal and CSS Anchor Positioning, which requires browser support for `anchor-name`, `position-anchor`, and `anchor()`. The trigger and menu share a unique anchor name. CSS prefers the position above the trigger with right edges aligned and an 8px gap, and keeps the menu within the layout viewport's 12px insets and desktop frame clearance. The trigger gap is preserved when desktop page zoom reflows the sticky composer. No JavaScript reads the trigger rectangle or tracks viewport changes for this placement. Pinch zoom scales the menu with the page; it may extend beyond the visual viewport, including while the keyboard is open. Model names ellipsize within the panel width while badges stay visible. The root controls, model list, and settings pages have their own scroll area inside the panel height limit.

The composer `ModelSelect` and `/model` option builder share [provider ordering](src/client/provider-order.ts), while both searches use `rankByName` within each provider. The command supplies optional groups and `searchMode: 'fuzzy-label'` through the [popupSelect API](../ui-commands/README.md#use-this-package); both entries use `MenuGroup` and rebuild its sticky observer when the rendered groups change. The command popup fills the composer overlay, while the button retains its compact menu.

Two entries over ONE per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`): the `/model` popupSelect contribution (registered through `ctx.commandUi`) and the composer's named `conversation.input.model` seat both load the session's available directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance, so a switch made in either entry is what the other shows next. Directory loads and selections share a generation counter so an older response never overwrites a newer one. The directory publishes the latest submitted selection as `pending` until it settles or a connection reset invalidates it; a connection reset drops every resident projection and repulls the Host-restored selection before display. Directories are per-session, resolved lazily, and disposed with the session scope; addressed subagent sessions expose neither entry. Every resident directory refetches directly on forwarded `llm/adapters-updated`, `llm/models-updated`, `settings/document-updated`, and credential update events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the model surface is not enough. They move from the browser surfaces to the command popup shell and the selection contract.

- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/model` contribution registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.model` seat.
- [dsh-agent-default-model](../../core/agent-default-model/README.md) — the default-model service for sessions that never choose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `session.selectModel` selection both entries submit: the Host snapshots the complete `ModelSelection` at the next prompt-assembly boundary and owns the model-visible effect, while a running step keeps its assembled selection.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current model surface. They are current package constraints, not a general model-router comparison or a task backlog.

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the reasoning slider absent.
- **Badges label the composer seat only** — `/model` popup rows, the trigger's accessible name, and its tooltip keep the plain catalog name.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
