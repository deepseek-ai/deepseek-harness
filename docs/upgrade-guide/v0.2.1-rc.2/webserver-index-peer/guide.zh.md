---
kind: upgrade-guide
description: "WebServer 渲染 index 时需要传入页面所代表的 Peer，`webserver/index-inject` 事件会把该 Peer 传给监听方。"
---
# WebServer 渲染 index 需要传入 Peer

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-host-webserver` 中 `ctx.webServer` 的 `renderIndex(html)` 与 `collectIndexInjections()` 不接收 Peer，每个 index 携带的都是 owner 的访问快照。现在它们改为 `renderIndex(html, peer)` 与 `collectIndexInjections(peer)`，`webserver/index-inject` 事件以第二个参数传入同一个 Peer，index 中的 remote-access 快照因此属于该 Peer。调用这两个方法的代码会在编译时报错；只读取表格的监听方不受影响。

## 迁移

1. 每处 `ctx.webServer.renderIndex(html)` 与 `ctx.webServer.collectIndexInjections()` 调用都传入页面所代表的 Peer。提供给 owner 浏览器的页面传入 `ctx.connection.browserPeer`。
2. 自行 emit `webserver/index-inject` 的测试在表格之后传入一个 Peer：`ctx.emit('webserver/index-inject', table, peer)`。
3. 运行 TypeScript 构建，确认这两个方法的调用都不再报缺少参数。
