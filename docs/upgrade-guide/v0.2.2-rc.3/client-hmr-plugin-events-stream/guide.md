---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-client-hmr` removes `GET /plugins/events` and `EVENTS_ENDPOINT` for the authenticated `pluginEvents/follow` Remote stream, and browser plugins receive synced configuration in `apply`."
---

# Plugin events stream and synced browser configuration

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-hmr` no longer registers the anonymous Server-Sent Events route `GET /plugins/events` and no longer exports `EVENTS_ENDPOINT`. Graph and rebuilt frames travel on the authenticated Typert Remote stream `pluginEvents/follow`: each stream generation opens with a `baseline` frame holding the full graph, followed by `graph` and `rebuilt` frames. Frame types come from `@deepseek-ai/dsh-client-hmr/types`. The browser face opens the stream over Connection and the API Gateway Client face while `remoteAccess` allows `pluginEvents/follow`; it no longer reads `window.__DSH_TRANSPORT__.fetch` or uses `EventSource`. A Peer whose Remote access does not allow `pluginEvents/follow`, such as a live-share viewer, no longer receives live graph or rebuilt updates.

Each graph row carries the plugin's [synced configuration](../../../../packages/client/modules/README.md#synced-plugin-configuration). A browser plugin whose Client face exports no `Config` schema receives a `SyncedConfig` object in `apply`, empty when its Host face declares no volatile fields, where it previously received `undefined`. A Client face that exports its own `Config` schema fails to activate when its graph row also carries synced values.

Affected: custom shells, scripts, and tests that read `/plugins/events` or import `EVENTS_ENDPOINT`; shells that supplied the plugin-events transport through `__DSH_TRANSPORT__.fetch`; deployments relying on viewer Peers following plugin changes; browser plugins that test their `apply` config for `undefined` or export a Client `Config` alongside volatile Host fields.

## Migration

1. Replace reads of `/plugins/events` and imports of `EVENTS_ENDPOINT` with a Remote client that mounts `@deepseek-ai/dsh-client-hmr/remote` and follows `pluginEvents.follow(signal)`; treat each `baseline` frame as a replacement of all earlier state, as [`src/client/index.ts`](../../../../packages/client/hmr/src/client/index.ts) does.
2. In a custom shell, provide the Remote carrier through Connection and the API Gateway Client face instead of a `__DSH_TRANSPORT__.fetch` handler for this endpoint.
3. Grant `pluginEvents/follow` in the Remote access policy of every Peer that must follow plugin changes; Peers without it reload the page to see them.
4. In browser plugins, stop treating an `undefined` `apply` config as "no configuration"; read fields through `SyncedConfig` from `@deepseek-ai/dsh-client-config/types`.
5. For a plugin with volatile Host fields, remove the Client face `Config` schema export and keep the only schema on the Host face, with the shared interface in `src/types.ts`.
6. Confirm: open the Web page, enable or disable a plugin, and check that the page updates without reload and that the browser sends no `/plugins/events` request.
