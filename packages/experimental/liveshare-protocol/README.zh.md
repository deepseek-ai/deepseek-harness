---
description: "owner bundle 与 Relay 共用的 Liveshare gateway 帧编解码，以及与 provider 无关的身份契约。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-liveshare-protocol

[English](README.md) | 中文

## 概述

`dsh-experimental-liveshare-protocol` 让 Liveshare owner bundle 与 Relay 共用同一份必须一致的定义：owner/worker 的 IPC 帧、Relay 不解析只转发的 gateway 帧、Relay 放进被服务页面的查看页载体脚本，以及与 provider 无关的身份契约及其回环 mock 实现。它让 owner bundle 与 Relay 共享这些定义而不必互相依赖，Relay 也不会加载 owner 侧代码。它依赖无状态的 `dsh-brand` 类型库，并把 `cordis` 声明为 peer。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

凡是需要说 Liveshare 线路协议或解析某个 viewer 身份的代码，都导入本包：owner host 及其 gateway worker、Relay server 及其验收测试。包根入口同时携带帧编解码、身份契约、查看页载体与查看页状态词汇；mock provider 位于 `src/identity/mock.ts`，仅供测试使用，任何包入口都不导出它。这是一个库——没有 profile 会挂载它，也没有 `cordis.yml` 行引用它。

### 入口

```ts
import { parseGatewayFrame, rawText, sendFrame } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf, normalizeIdentity } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
```

查看页载体（`installViewerCarrier`）与查看页状态词汇通过根入口发布，而不是各自的子路径，因为 owner 页面的两个面会一起消费它们。

`parseGatewayFrame` 返回一个校验通过的帧，对畸形或未知输入返回 `undefined`，因此本构建不认识的 gateway 帧不会让连接失败。需要回答对端而不是让它空等的调用方使用 `unsupportedFrameRefusal`，它把一个本构建无法服务的帧变成要回送的拒绝。`identityKeyOf` 把一个 actor 渲染成所有 ACL 比较使用的 `providerId:tenantId:subjectId` 键，`normalizeIdentity` 为不签发 tenant 的 provider 填入文档化的 `default`。

Relay 兼容性依靠声明版本、能力和明确拒绝，不提供逐发布版本的帧翻译或共同子集协商。独立部署的对端没有约定的历史支持窗口，因此逐版本适配会引入数量无界、需要持续维护的行为。已发布的可选 Relay 字段保持可选；能力名仅为已经实现的行为新增，绝不重命名或重新解释。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`tunnel-protocol.ts` 只定义帧：`sendFrame` 接收任何带 `readyState` 与 `send` 的 socket，因此本包不需要 socket 依赖，owner gateway 与 Relay 各自传入自己的 `ws` 实例。`identity/` 持有 provider 契约、规范 ACL 身份键编解码，以及 loopback 用的 `mock` provider。两半都不导入 owner 代码，因此 Relay 可以依赖本包而不依赖 owner bundle。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 为只想一次导入的调用方复出两个面 |
| [`src/tunnel-protocol.ts`](src/tunnel-protocol.ts) | owner/worker IPC 帧、gateway 帧及其编解码 |
| [`src/viewer-carrier.ts`](src/viewer-carrier.ts) | 查看页载体脚本及其转发的 owner 页面路由；经根入口引入 |
| [`src/viewer-states.ts`](src/viewer-states.ts) | 查看页状态词汇及其应答，由根入口复出 |
| [`src/identity/types.ts`](src/identity/types.ts) | 与 provider 无关的身份三元组与 `IdentityProvider` 契约 |
| [`src/identity/keys.ts`](src/identity/keys.ts) | 规范 ACL 身份键编解码，以及 adapter 存入身份前的 tenant 规范化 |
| [`src/identity/mock.ts`](src/identity/mock.ts) | 供本地运行与测试使用的 loopback 身份 provider |
| — | 本包不持有可变状态、不做注册，因此不发布 runtime invariant companion；这些编解码由本包自己的测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——实验性包状态。
- Liveshare owner bundle 与 Relay 消费这些帧，单独发布。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 网关请求必须在不透明请求体之外携带 Relay 已认证主体；没有该主体的帧被拒绝。
- Owner Host 与 worker 同包发布。Supervisor 为每次逻辑添加生成品牌化 UUID `registrationToken`，移除时使其失效，进程重启只为仍保留的同一注册重播该身份。生命周期、请求及取消事件回传该 token 与分享 ID；逐请求 `TunnelRequestToken` 独立存在。IPC 编解码拒绝缺失身份，两种 token 都不进入 Relay URL 或线协议帧。同包 IPC 不协商版本；Relay 线协议帧保留数字 ID 与协议版本 1。兼容能力包含 `file-upload`、`actor-credential` 与 `direct-connection`。actor 可携带可选的、owner 可验证的 `credential`（协议只校验类型；owner 在采信断言身份前自行验证，缺失时保持今天由 Relay 断言的语义）。分享 spec 可携带 `connection`；缺失读作 `{ mode: 'relay' }`，仍拥有数据面的 Relay 会拒绝 `direct` 注册。：声明它的 Relay 注册可在分享支持与 access-state 帧上携带 `allowsFileUpload`；其它 peer 保留已存值，而缺少该字段的帧读作上传关闭。
- 声明 `share-access-state` 的 owner 接收已提交、无 id 的 ACL、模式与到期时间快照，快照携带持久单调版本。worker 只转发当前 socket 的快照；Host 在 socket 丢失后清空授权，并在外部执行准入前刷新已认证的请求快照。快照不可用时默认拒绝，不借用持久化 ACL。
- **历史发布版本支持尚未核实**——`tests/frames/v1` 记录具体帧和拒绝义务，但没有标识已发布的 Owner 版本。网关声明 `LIVESHARE_PROTOCOL_VERSION` 与已实现能力；Relay 拒绝已声明的版本不匹配，仅向已声明消费者发送可选生命周期帧。这些检查保留已录字段和明确拒绝，不提供逐发布版本翻译或无限支持窗口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
