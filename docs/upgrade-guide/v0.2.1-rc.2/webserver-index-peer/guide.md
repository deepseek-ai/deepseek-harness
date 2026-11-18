---
kind: upgrade-guide
description: "WebServer index rendering takes the Peer the page speaks for, and the `webserver/index-inject` event passes that Peer to listeners."
---
# WebServer index rendering takes a Peer

English | [中文](guide.zh.md)

## Change

`renderIndex(html)` and `collectIndexInjections()` on `ctx.webServer` from `@deepseek-ai/dsh-host-webserver` took no Peer, and every index carried the owner's access snapshot. They are now `renderIndex(html, peer)` and `collectIndexInjections(peer)`, and the `webserver/index-inject` event passes the same Peer as its second argument, so the remote-access snapshot in the index belongs to that Peer. Code that calls either method breaks at compile time; listeners that read only the table keep working.

## Migration

1. Pass the Peer the page speaks for to every `ctx.webServer.renderIndex(html)` and `ctx.webServer.collectIndexInjections()` call. A page served to the owner's browser passes `ctx.connection.browserPeer`.
2. In a test that emits `webserver/index-inject` itself, pass a Peer after the table: `ctx.emit('webserver/index-inject', table, peer)`.
3. Run your TypeScript build and confirm no call to either method reports a missing argument.
