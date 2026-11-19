---
kind: upgrade-guide
description: "未指定时区的 SDK prompt 现在向模型上报运行时进程时区，而不再是时区不可用。"
---

# SDK prompt 默认上报进程时区

[English](guide.md) | 中文

## 变更

在早期版本中，每条 SDK prompt 送达模型时都带有 `Browser time zone for this request: unavailable.`，因此模型会请用户澄清未限定时区的日期与时间。现在每条普通 prompt 都像 Web prompt 一样上报时区：使用随 prompt 传入的 `timeZone`，否则使用运行时为这条 prompt 采样的进程时区。模型随后按该时区解释未限定的日期与时间，例如 `Browser time zone for this request: UTC. Interpret otherwise-unqualified dates and times in this zone.`。

受影响的是不传时区的 TypeScript 与 Python SDK 应用，以及直接调用 `session/prompt` 和 `session/query` 的 JSON-RPC 客户端。容器通常运行在 `UTC`，它可能不是用户的时区。进程时区既不是 `UTC` 也不是 IANA Area/Location 名称时（例如 `TZ=GMT` 下的 `+00:00`），仍上报 `unavailable`。不符合这些格式的显式时区现在会让请求失败。原生 slash 命令不变，不记录时区。

## 迁移

1. 用户时区与运行时进程时区不同时，为每条 prompt 传入用户时区：
   - TypeScript：`session.run(input, { timeZone: 'Asia/Shanghai' })`、`harness.run(input, { timeZone })` 或 `client.prompt(sessionId, blocks, { timeZone })`。
   - Python：`session.run(input, time_zone="Asia/Shanghai")`、`harness.run(input, time_zone=...)` 或 `client.session_prompt(session_id, blocks, time_zone=...)`。
   - JSON-RPC：在 `session/prompt` 或 `session/query` 的 params 中加入 `"timeZone": "Asia/Shanghai"`。
2. 如果一个运行时只服务同一时区的用户，也可以在运行时环境中设置 `TZ`，例如 `TZ=Asia/Shanghai`。
3. 用一条询问当前时间的 prompt 确认：模型请求中包含 `Browser time zone for this request: <你的时区>.`；带非法时区（例如 `CST`）的请求以写明该值的 JSON-RPC 错误失败。
