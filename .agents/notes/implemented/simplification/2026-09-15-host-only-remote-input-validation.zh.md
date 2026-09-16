# Agent Note: 仅在 Host 校验 Remote 输入

Status: implemented

[English](2026-09-15-host-only-remote-input-validation.md) | 中文

## Problem

生成的 Client Remote 方法公开 TypeScript 签名，并通过 Connection 把调用转给 Host Gateway；Host Gateway 已经在 lookup 或业务调用前检查精确参数字段、执行每个严格输入 codec，并验证 JSON 数据。Client 再为每个参数执行对应 schema 会重复这次校验，在 Client 中实例化原本惰性创建的 Zod schema，还会让无效 JavaScript 调用根据哪一侧先拒绝而走不同的失败路径。

Client 仍需要 descriptor 元数据来检查位置参数数量、把值映射为具名 wire 字段、绑定 scoped Context identity、省略显式为 undefined 的可选值，以及合并取消信号。这些操作都不需要执行运行时 schema。

## Decision

Client Remote 在挂载 contribution 时校验 descriptor 完整性，随后直接转发带类型的参数与绑定的 Context identity，不调用 invocation codec factory。位置参数数量错误与 Client Context binding 缺失仍在本地拒绝。成功的一元结果与流项同样不经 Client 侧类型解析直接传递。

Host Gateway 拥有运行时输入校验。它检查精确具名字段、执行严格参数与 identity codec、验证 JSON 值，并在调用业务代码前完成 lookup。绕过生成 TypeScript API 的 JavaScript 调用方，其请求到达 Host 后会收到 Host 的 `gateway/input-invalid` 结果；无法进入载体的值则可能在序列化时失败。

生成的 Remote contribution 继续携带 codec 元数据，因为 Host 与 Client 产物仍共享 `InvocationDescriptor`，Client 挂载也仍要求每个 Client 供值字段具备严格 codec。完整 Remote 架构见 [Typert 生成的 Remote 方法调用](../architecture/2026-08-02-typert-remote-method-calls.zh.md)；本决策只取代其中 Client 侧执行调用 codec 的部分。

## Alternatives considered

- **同时保留 Client 与 Host 输入解析。** 这样能让畸形 JavaScript 调用方更早收到本地错误，并在传输前剔除对象中的未声明属性；但即使 Host 必须独立校验，每次有效调用仍要重复实例化并执行 schema。
- **从 Remote Client 产物中移除 codec 元数据。** 这样可以进一步缩小生成的 Client 代码，但会改变共享 descriptor 与 generator 协议。保留惰性 factory 能继续检查严格 contribution，同时不产生运行时 schema 构造成本。

## Consequences

正常 Client 调用不再分配 invocation schema，也不再重复执行 Zod parse。Host 校验仍是 lookup 与业务执行前的权威检查，Client 代码则保留参数数量、Context binding、取消与 contribution 生命周期故障。

畸形运行时值会比以前更晚失败。未声明的对象属性可能在 Host codec 剔除它们之前经过可信载体，因此从不可信对象或含秘密对象派生请求的调用方必须构造已声明 DTO，不能把 Client 解析当作脱敏步骤。Client 测试固定原样转发行为，Host 测试固定严格输入与 JSON 输入拒绝。
