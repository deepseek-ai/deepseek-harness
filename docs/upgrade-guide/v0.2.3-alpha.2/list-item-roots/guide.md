---
kind: upgrade-guide
description: "List slot output now sits inside item roots, changing direct-child selectors, sibling relationships, and empty-state checks."
---

# DOM selectors for list slot items

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, a Web Client `list` slot placed each winning component's output directly inside its `[data-slot]` outlet. After upgrading, each winner has one `[data-slot-item]` root, including when `only` selects one `id`. The outlet itself, other slot kinds, and registration APIs are unchanged. Plugins that style or inspect the list DOM need to account for the new parent. See [list item roots](../../../subsystems/slots.md#list-item-roots) for the element tags, fallback, and error cases.

## Migration

1. In your CSS and DOM queries, change selectors for contributed elements, for example `[data-slot="conversation.session.header.actions"] > button` to `[data-slot="conversation.session.header.actions"] > [data-slot-item] > button`. The button's `parentElement` is its item, not the outlet. A `button + button` selector can still match within a single Fragment, but not across registrations. Check `:last-child` rules too: the last item can be empty. For a list inside a paragraph, declare `inline: true` and return phrasing content. Where neither `div` nor `span` is a valid child, such as directly under `tr`, move the outlet.
2. In interaction tests, find the control by role and name within the intended outlet, for example `getByRole('button', { name: 'Review' })`, rather than taking `outlet.firstElementChild`. Click the button and verify its action. Check its dimensions with `button.getBoundingClientRect()`; the item's `display: contents` gives the item no box to measure.
3. Render with `{ only: 'review', fallback: <i>Unavailable</i> }`. For a matching component that returns `null`, `[data-slot-item]:empty` matches but the outlet is not `:empty`. Return `'Ready'` instead: the item has no element children, but its text makes it nonempty. Use an unregistered `id` and confirm that the `<i>` appears directly under the outlet, without an item root.
