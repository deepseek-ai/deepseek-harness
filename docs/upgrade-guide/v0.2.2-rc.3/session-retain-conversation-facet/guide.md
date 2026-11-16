---
kind: upgrade-guide
description: "Client plugins that render a Session's Conversation retain it with the conversation facet."
---

# Request the `conversation` facet when rendering a Session

English | [中文](guide.zh.md)

## Change

`sessions.retain()` in `@deepseek-ai/dsh-api-session-controller/client` accepts an optional `facets` record. Every reference still keeps the Session's history stream, but Conversation assembly now runs only while some reference retains the `conversation` facet that `@deepseek-ai/dsh-client-ui-conversation` declares. The existing call signature still compiles. A Client plugin that retains a Session under its own source to render it inside a `SessionProvider`, without that facet, shows the Conversation snapshot from the last time another view rendered the Session, or an empty one, and its quota notices stop. The shipped main view, right Sidebar Session views, and subagent Sidebar chat already request the facet; plugins that retain a Session only to call its operations are unaffected.

`SessionRetainInfo`, read through `sessions.retainInfo(id)`, gains an optional `retainedFacets` count record that is absent while no reference retains any facet.

## Migration

1. Find each `sessions.retain(target, { source: ... })` call whose reference you pass to a `SessionProvider` that renders Conversation content.
2. Add the facet to those calls:

   ```ts ignore-check
   sessions.retain(target, { source: 'myPanel', facets: { conversation: true } })
   ```

3. Leave `sessions.using()` calls and references that only call Session operations unchanged.
4. Confirm the migration: open your view on a Session that the main view does not show, send a prompt from it, and check that the reply appears while you watch; `sessions.retainInfo(id).getSnapshot().retainedFacets?.conversation` reads a positive count while your view is open.
