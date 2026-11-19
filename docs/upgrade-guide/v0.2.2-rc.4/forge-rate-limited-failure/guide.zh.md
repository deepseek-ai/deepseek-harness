---
kind: upgrade-guide
description: "ForgeFailure.code 新增 rate-limited，forge-github 在 GitHub 按限流拒绝读取时返回它，对该代码做穷尽 switch 的代码因此无法通过编译。"
---

# `ForgeFailure.code` 新增 `rate-limited`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-experimental-forge` 的 `ForgeFailure['code']` 新增 `'rate-limited'`：托管平台按限流拒绝了读取，限额重置之后再读才会成功。[forge-github](../../../../packages/experimental/forge-github/README.zh.md#use-this-package) 遇到 GraphQL `RATE_LIMITED` 错误、HTTP 429，或提到主限流、次级限流的消息时返回它，此前这些情况都报告为 `unavailable`。状态轮询、检查读取、评审读取、diff、文件读取、登录用户的列表与描述读取都可能返回它。

受影响的是对 `ForgeFailure['code']` 做穷尽 switch 的第三方插件：以 `assertNever` 结尾、或声明了 `Record<ForgeFailure['code'], …>` 的代码会编译失败；把文档列出的代码之外的值都当作不可能出现的代码也会受影响。从不返回 `rate-limited` 的提供方无需修改。

## 迁移

1. 在插件中搜索 `ForgeFailure['code']`、`failure.code`，以及针对 forge 失败的 `assertNever(`，给每个穷尽的 switch 或 record 加上 `'rate-limited'`。没有限流处理时按 `unavailable` 对待；有限流处理时，等一段时间再读取。
2. 能识别主机限流的提供方，可以在任何返回 `ForgeFailure` 的读取中返回 `{ code: 'rate-limited', message }`。
3. 运行类型检查；所有穷尽的 switch 都列出新代码后即可通过。
