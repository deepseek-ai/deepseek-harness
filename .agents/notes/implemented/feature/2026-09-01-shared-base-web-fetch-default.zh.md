# Agent Note: 共享 base 的 Web 抓取默认值

Status: implemented

[English](2026-09-01-shared-base-web-fetch-default.md) | 中文

本决策部分取代[已交付组合中的默认 Web 搜索](2026-07-31-web-default-search.zh.md)里关于抓取按需启用的选择。该记录继续负责搜索提供方选择、凭据、端点、超时，以及提供方可用性与模型工具注册之间的区分；没有任何 active Agent Note 被完全取代或符合归档条件。

## 问题

所有随附的完整 agent 产品都接受匿名公开 Web 抓取，但 `dsh-base` 会禁用 `web_fetch`，要求每个应用组合包重复相同的覆盖。重复配置遗漏了 ACP，使新的 base-backed profile 默认只有搜索能力，除非作者注意到这个例外，还迫使产品之间原本相同的 snapshot header 分开维护。

## 决策

`packages/bundle/base/cordis.patch.yml` 以 `fetch: true` 和随附的 60 秒搜索超时挂载 `dsh-tool-web`。Headless、完整 SDK、ACP 与仅使用 base 的自定义 profile 会继承 `web_search` 和 `web_fetch`，无需应用级覆盖。Web app 会禁用 base 工具配置项，并按 agent preset 组合相同的一对工具。独立的 `sdk-minimal` profile 不使用 base，因此保持不变。

base HTTP 提供方只允许匿名请求经过验证的公开 `http:` 与 `https:` 目的地址。抓取在 shell 和文件系统 sandbox 或审批 preset 之外执行，无需逐次审批；公开目的地址校验不会阻止向公网发送数据。需要不同网络策略的产品应在后续组合包或 profile patch 中覆盖完整的 `tool-web` 配置。

## 考虑过的替代方案

**在 base 中禁用抓取，再由每个产品分别启用。** 不予采纳：所有随附的完整产品都选择相同能力，重复配置没有表达产品差异，还可能遗漏未来的 base-backed profile。

**只增加 ACP 覆盖。** 不予采纳：这种方式能修复当前遗漏，但会保留三处重复的应用级设置，也会让未来 profile 面临相同问题。

## 后果

基于 base 的模型请求默认暴露抓取 schema 与 prompt 指引，包括 ACP 自动化和只列出 `dsh-base` 的自定义 profile。受限部署必须显式关闭。Headless、SDK 与 ACP 可以共享相同的模型 header snapshot 来源，聚焦的真实 profile 测试会固定随附工具集合。
