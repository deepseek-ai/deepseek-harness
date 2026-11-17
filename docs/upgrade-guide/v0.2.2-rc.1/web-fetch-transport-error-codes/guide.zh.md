---
kind: upgrade-guide
description: "本地 HTTP 抓取的传输故障改为抛出分类后的 WEB_FETCH_* 代码，而不是 WEB_PROVIDER_ERROR。"
---

# 本地 HTTP 抓取的传输故障使用分类代码

[English](guide.md) | 中文

## 变更

本地 HTTP 抓取提供方（`dsh-web-fetch-http`）以前在响应之前或响应期间遇到任何网络故障时，都会抛出 `WEB_PROVIDER_ERROR`，文本为 `web fetch failed: TypeError: fetch failed`。现在它会抛出 `WEB_FETCH_DNS_FAILED`、`WEB_FETCH_CONNECTION_REFUSED`、`WEB_FETCH_CONNECTION_TIMEOUT`、`WEB_FETCH_CERTIFICATE_INVALID`、`WEB_FETCH_CONNECTION_INTERRUPTED`、`WEB_FETCH_NETWORK_UNREACHABLE` 之一；无法识别的故障则抛出 `WEB_FETCH_NETWORK_ERROR`。错误消息会写明故障类别、系统错误码和底层错误。新的 `web_fetch` 工具结果的 `error.code` 中也会出现相同的代码。受影响的是 `ctx.web.fetch()` 的调用方，以及对网络故障匹配 `WEB_PROVIDER_ERROR` 的工具结果错误码读取方。其他提供方，以及 `dsh-web-fetch-http` 的其他故障，均不受影响。

## 迁移

1. 如果代码按 `WEB_PROVIDER_ERROR` 路由本地抓取的网络故障，改为匹配上述七个代码。
2. 不要解析错误消息文本；它仅用于诊断，可能会变化。
3. 抓取一个无法解析的主机（例如 `http://example.invalid/`），确认错误码为 `WEB_FETCH_DNS_FAILED`。
