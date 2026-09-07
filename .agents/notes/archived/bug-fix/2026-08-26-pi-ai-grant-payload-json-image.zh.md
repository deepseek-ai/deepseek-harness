# Agent Note: pi-ai grant payload 落盘其 JSON 像

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-pi-ai-grant-payload-json-image.md) | 中文

## Problem

一次面向 github.com 的 GitHub Copilot 登录在提交环节失败：`credentials-local: record "llm-pi-ai/github-copilot" payload holds a value JSON cannot represent`。pi-ai 的 Copilot 凭据以显式 `undefined` 携带可选成员（未填 Enterprise 域名时为 `enterpriseUrl: undefined`——这是 `JSON.stringify` 会直接丢弃的 JavaScript 惯用写法），而 `llm-pi-ai` 的存储桥接把凭据对象原样作为 grant payload 提交。凭据存储的校验器正当地拒绝 `undefined` 为不可表示，于是所有流程留有未填可选成员的 grant 都无法落盘，提供方已经完成授权之后登录却报失败。

## Decision

`packages/llm/llm-pi-ai/src/auth.ts` 的 `toRecord` 改为落盘 grant 凭据的 JSON 像：`jsonImage` 丢弃普通对象里显式为 undefined 的成员，把数组中的 undefined 条目渲染为 `null`，与 `JSON.stringify` 完全一致。其余一切——非有限数、异种原型对象——原样透传，因此真正不可存储的值仍会在存储校验器处大声失败，而不是被静默改写。读回不变：成员缺失与显式 undefined 对以属性读取访问可选成员的 pi-ai 消费方不可区分。

## Testing

`tests/auth.spec.ts` 经真实 `LocalCredentialProvider` 写入 Copilot 形状的 grant（显式 `undefined` 成员、嵌套丢弃、数组空洞），断言落盘 payload 为 JSON 像；第二个用例提交带 `Date` 成员的 grant 并断言存储的拒绝到达调用方，证明 fail-loud 路径仍在。

## Alternatives considered

**`JSON.parse(JSON.stringify(credential))`。**否决：它还会把 `NaN`/`Infinity` 渲染为 `null` 并执行 `toJSON` 方法，把严格校验器本要大声拒绝的值静默改写掉。

**放宽存储校验器、跳过 undefined 成员。**否决：seam 存储的 payload 它从不读取或改写，所有生产方都依赖逐字节往返；归一化属于了解自家库惯用法的生产方，而不是所有插件共享的存储。

**在 pi-ai 上游修掉未填成员。**不在本仓库掌控内且随版本脆弱：将来任何流程重新引入该惯用法都会再次弄坏登录。由桥接层拥有这次翻译，让 harness 对整类问题免疫。

## Consequences

所有 pi-ai 流程的 grant 无论留空哪些可选成员都能落盘。桥接层现在拥有一次单向归一化：写入时显式为 undefined 的成员在读回时缺失，这对属性访问不可区分，且正是文档化的 JSON 语义。
