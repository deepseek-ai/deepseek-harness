# Agent Note: 在请求接收处只解析一次 SSH 策略

Status: proposed

[English](2026-10-18-parse-ssh-policy-once.md) | 中文

## Problem

[`sandbox` 和 `fs.write`/`fs.edit` 处理函数](../../../../packages/ssh/ssh/src/helper.ts) 是私有策略解析器仅有的调用方。它们使用 `policySchema` 校验请求；解析器重复该解析，包括复制策略对象和额外根目录数组。

## Proposal

让私有解析器接收 `z.output<typeof policySchema>`，移除其中的解析。保留两个线上请求解析器、执行主机上的路径解析、取消、SessionId 品牌类型转换，以及对值为 undefined 的可选字段的显式省略。[SSH 执行决策](../../implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) 继续规定远程策略执行。

## Alternatives considered

**保留解析器的 unknown 输入。** 它能保护未来未经解析的调用方，但当前调用方已经解码。类型化参数可表达必要前提，无需重复执行运行时工作。

## Acceptance criteria

两个请求处理函数仍拒绝格式错误的策略、相对根目录和意外字段。远程物理根目录检查和返回策略保持不变。现有辅助进程测试覆盖未提供和已提供根目录、只读策略以及被拒绝的写入。

## Risks

未来的线上请求调用方必须先校验，再调用解析器。保留可选字段省略，因为 Zod 允许显式 `undefined`，而执行策略类型不允许。
