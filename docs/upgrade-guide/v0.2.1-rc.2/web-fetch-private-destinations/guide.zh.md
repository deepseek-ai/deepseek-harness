---
kind: upgrade-guide
description: "HTTP 抓取提供方不再拒绝非公开目标，HttpFetchProvider 也不再接受地址解析器。"
---
# `web_fetch` 可以访问私有目标

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-web-fetch-http` 以前会解析每个主机名，以 `WEB_BLOCKED_URL` 拒绝任何 loopback、私有、link-local 或保留地址，并把连接固定到已校验地址。现在它通过已安装的代理策略和系统解析器发送每个请求，因此 `web_fetch` 可以访问 loopback、内网与云元数据主机。使用 fake-IP DNS 的 TUN 模式代理之后，抓取无需配置即可工作。

本包不再导出 `HttpFetchResolver`，`HttpFetchProvider` 构造函数只接受 `HttpFetchLimits`。

依赖该提供方阻止模型访问私有服务的部署会受影响；向 `HttpFetchProvider` 传入解析器的代码也会受影响。

## 迁移

1. 如果模型不得访问私有目标，请限制进程的网络访问、添加拒绝这些 `web_fetch` URL 的 `tools/pre-execute` 策略，或从组合中移除 `@deepseek-ai/dsh-tool-web` 的抓取工具。
2. 把 `new HttpFetchProvider(limits, resolveAddresses)` 替换为 `new HttpFetchProvider(limits)`。如需把测试请求指向本地服务器，请把服务器地址写进 URL，而不是覆盖解析。
3. 用 `pnpm run typecheck` 确认迁移完成，且不再引用 `HttpFetchResolver`。
