# Agent Note：SDK prompt 逐条上报时区

Status: implemented

[English](2026-11-09-sdk-prompt-time-zone.md) | 中文

## 问题

Web 与 Desktop 的 prompt 携带浏览器时区，Host 规范化后把它记录在该条用户消息上，[time-context](../../../../packages/context/time-context/README.zh.md) 随后让模型按该时区解释未限定时区的日期与时间。SDK prompt 记录的是 `{ kind: 'user' }`，而 time-context 只从同时带有 Web `rpcId` 的 user 来源读取时区。因此每个 SDK 请求都显示 `Browser time zone for this request: unavailable.`，模型会就 Web 用户从不会被追问的日期去询问用户。SDK 协议也没有字段让嵌入方应用上报其用户的时区。

## 决定

时区仍是请求本地的消息来源数据，与[显式定时任务时区决定](../simplification/2026-08-09-explicit-schedule-time-zone.zh.md)一致；SDK 逐条 prompt 提供它。

- `session/prompt` 与 `session/query` 接受可选的 `timeZone`。TypeScript 客户端在 `HarnessClient.prompt()` 选项和 `run()` 选项中接受它；Python 客户端在 `session_prompt()` 和 `run()` 中接受 `time_zone` 关键字参数。
- SDK server 用 Web Host 所用的同一检查 `canonicalClientTimeZone` 规范化显式值。被拒的值让该请求以 `TypeError` 失败，与 server 的其他参数错误一样应答为 JSON-RPC `-32603`，发生在创建 Session 或路由输入之前。
- 省略时，在接受每条 prompt 时采样 `Intl.DateTimeFormat().resolvedOptions().timeZone`。采样值无法规范化时（例如 `TZ=GMT` 下的 `+00:00` 或 `Etc/Unknown`），不记录时区，也不让 prompt 失败。
- prompt 记录不带 `rpcId` 的 `sdk-user` 消息来源 `{ kind: 'user', clientTimeZone? }`。`rpcId` 标识一次 Web 提交，用于 prompt 确认和附件回收，SDK 没有这样的提交。
- `reportedBrowserTimeZone` 从任何 `user` 来源读取字符串 `clientTimeZone`。写入方在提交前规范化，请求准备阶段仍拒绝非规范值，因此 Web 路径和模型可见文本都不变。
- 原生命令不记录时区。Web 通过 `commands.execute` 执行 slash 命令且不带 `clientTimeZone`，SDK `session/query` 把命令路由到同一批 handler，因此两条路径上的 `/plan <text>` 都 steer 一条不带时区的消息。

## 备选方案

**向每个请求注入一个运行时级时区。** 由 time-context 应用的进程或配置时区也能覆盖进程内子 agent 与插件消息，但它会把部署事实当作用户依据呈现。time-context 已有回退显示时区，并且有意保留 `unavailable` 策略。

**在 SDK prompt 上写入合成的 `rpcId`。** 这样可以原样复用 Web 来源变体，但 Web 客户端用 `rpcId` 结算提交并回收附件，合成标识会声称存在一次从未发生的 Web 提交。

**在 `initialize` 时固定时区。** 每个连接一个值可以省去每条 prompt 的字段，但长期运行的运行时可能服务不同时区的用户，进程时区也可能变化，该值会过时。逐条 prompt 的值与 Web 浏览器采样一致。

## 影响

- 不传时区的 SDK 嵌入方现在上报运行时进程时区。容器中通常是 `UTC`，可能与用户时区不同；[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.5/sdk-prompt-time-zone/guide.zh.md)要求使用方传入 `timeZone` 或 `time_zone`，或设置 `TZ`。
- SDK subagent 子运行时收到的 prompt 不带时区，因此上报自身进程时区；进程内子 agent 与 Web 上一样看到 `unavailable`。
- 早于放宽检查的读取方会忽略 SDK prompt 的时区；[持久化记录](../../../../docs/persistence-changes/2026-11-09-sdk-prompt-time-zone.zh.md)保持格式版本不变。
- `packages/sdk/server/tests/time-zone.spec.ts` 固定规范化、拒绝、采样与不可用时区，`session/query` 路由，以及 SDK 与原生命令路径上一致的 `/plan` 来源。`apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts` 通过随发行版交付的 `sdk` profile 断言模型可见的那一行。SDK snapshot 驱动发送 `timeZone: 'UTC'` 并在 `TZ=UTC` 下运行。
