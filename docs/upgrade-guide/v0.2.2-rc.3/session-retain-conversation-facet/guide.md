---
kind: upgrade-guide
description: "Client plugins that render a Session's Conversation retain it with the conversation facet."
---

# Request the `conversation` facet when rendering a Session

English | [中文](guide.zh.md)

## Change

`sessions.retain()` in `@deepseek-ai/dsh-api-session-controller/client` accepts an optional `facets` record. Every reference still keeps the Session's history stream, but Conversation assembly now runs only while some reference retains the `conversation` facet that `@deepseek-ai/dsh-client-ui-conversation` declares. The existing call signature still compiles. A Client plugin that retains a Session under its own source to render it inside a `SessionProvider`, without that facet, shows the Conversation snapshot from the last time another view rendered the Session, or an empty one, and its quota notices stop. The shipped main view, right Sidebar Session views, and subagent Sidebar chat already request the facet; plugins that retain a Session only to call its operations are unaffected.

`retain()` also accepts `connection`, `true` by default; `false` keeps the Session object and its local state, such as the composer draft, without its event connection or event window. `SessionRetainInfo`, read through `sessions.retainInfo(id)`, gains optional `retainedFacets` and `connectionCount` counts that are absent while zero.

## Migration

1. Find each `sessions.retain(target, { source: ... })` call whose reference you pass to a `SessionProvider` that renders Conversation content.
2. Add the facet to those calls:

   ```ts ignore-check
   sessions.retain(target, { source: 'myPanel', facets: { conversation: true } })
   ```

3. Leave `sessions.using()` calls and references that only call Session operations unchanged; pass `connection: false` only when the reference needs neither events nor history.
4. Confirm the migration: open your view on a Session that the main view does not show, send a prompt from it, and check that the reply appears while you watch; `sessions.retainInfo(id).getSnapshot().retainedFacets?.conversation` reads a positive count while your view is open.
