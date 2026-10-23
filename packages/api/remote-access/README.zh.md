---
description: "非 owner Peer 的 Remote 方法级访问控制：基于角色的 policy 判定、列表过滤与每个 Peer 的访问快照。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-access

[English](README.md) | 中文

## 概述

决定非 owner Peer 可以调用哪些 Remote 方法、可以收到哪些转发事件。业务包定义 role（限定一种资源种类的 action 集合），并为每种非 owner principal kind 注册一个 policy，把 role 绑定到资源上。[API Gateway](../gateway/README.zh.md) 解析一次调用或一个事件访问的资源，并在解析 lookup、解码参数之前询问本包。列表方法经 `allows()` 逐项过滤；每个 Peer 订阅自己的访问快照，Client 据此隐藏 Host 会拒绝的入口。设计由 [Peer 身份属性 Agent Note](../../../.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.zh.md) 负责。

## 目录

- [Host 服务：`RemoteAccessService`（ctx key：`remoteAccess`）](#host-service)
- [Client 面](#client-face)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="host-service"></a>
## Host 服务：`RemoteAccessService`（ctx key：`remoteAccess`）

挂载 [API Gateway](../gateway/README.zh.md) 的组合都要挂载本服务：Gateway 注入 `remoteAccess`，没有它就不启动。[`bundle/base`](../../bundle/base/cordis.patch.yml) 紧随 `typert-gateway` 装配它。owner（`{ kind: 'owner' }`）从不受检查；下列成员都只针对非 owner principal。

| 成员 | 契约 |
|---|---|
| `registerPolicy(kind, policy)` | 为一种非 owner principal kind 注册 `RemoteAccessPolicy`；其 `bindings()` 与 `explain()` 收到的 principal 按该 kind 定型。同一 kind 再注册一个 policy 即抛错。登记是调用方 fiber 的 Cordis effect；注册与撤回都会重新计算已打开的快照。 |
| `invalidate(principal?)` | 报告某个 principal（省略时为所有 principal）的 binding 或 condition 结论可能已变化。业务包在每次授权、撤权、模式切换与过期时调用。 |
| `decide(request)` | 仅供 Gateway 使用。`request` 为 `{ principal, action, resources, args? }`：调用方或接收方、端点 `ns/method` 或 `event:<name>`、Gateway 解析出的合法资源，以及调用中按 Typert 编译类型校验后的参数（lookup 参数为 wire 身份）。返回 `{ kind: 'allow' }` 或 `{ kind: 'deny', reason }`；调用被拒时由 Gateway 抛出 details 为 `{ action, reason }` 的 `remote-access/denied`，事件被拒时由 Gateway 直接丢弃、不构造错误。owner 与 `remoteAccess/follow` 恒放行。 |
| `allows(resource)` | 读访问本服务的 Context 上的 invocation，因此列表方法对每一项调用 `this.ctx.remoteAccess.allows(resource)`。不带参数判定该调用的端点 action 在该资源上是否被允许，每次判定都重新读取 binding。owner 与 Remote 调用之外恒为 true。 |
| `snapshotFor(principal)` | 页面打开时的 baseline：owner 为 `{ type: 'baseline', owner: true }`，否则为该 principal 当前的 grant。 |
| `follow(signal)` | Remote stream `remoteAccess/follow`：一个 `baseline`，之后是 `upsert` 与 `remove` 帧。owner 只收到 `{ type: 'baseline', owner: true }`。`signal` abort 或服务卸载时流结束，因此重载后的服务从新的 baseline 回答每个读者。 |

role `{ name, resource, actions }` 是普通值，表示限定一种资源种类（`global` 或在 `TypertResourceMap` 中声明的种类）的 action 集合。binding `{ role, resource, condition? }` 在该 role 种类的一个资源上授予该 role。policy 根据预先载入内存的状态同步回答 `bindings(principal)` 与可选的 `explain(request)`。只有在每个已解析资源上都有某个 binding 指向该资源、其 role 列出该 action、且没有 condition 或 condition 放行时，请求才被放行。资源之间相互独立：`global` 上的授权不蕴含任何其他资源上的授权，任何资源也不蕴含另一个资源。condition 收到 `{ action, resource, args? }`，只对资源与 role 都匹配的 binding 调用；事件、快照与列表过滤时没有 `args`。`bindings()` 在每次 `decide()`、每次 `allows()` 判定与每次快照计算中各调用一次，不跨判定缓存，因此依赖时间的状态对下一次调用即时生效。

Gateway 依次从 `@Remote` 与 `@RemoteScope` 的 `resources` 读取函数、lookup 与 Host Context adapter 的 `resource` 声明、`typert.resources` 中的默认字段或 resolver 声明解析资源，解析顺序由 [API Gateway](../gateway/README.zh.md) 负责；本包不读取任何参数字段。不指明任何资源的调用只访问 `global` 资源，因此只有 `global` 级 role 能放行；把某个 action 放进 `global` 级 role，等于允许该 principal 在调用未指明的任何资源上调用它。资源非法的调用由 Gateway 以 `resource-invalid` 拒绝，不询问 `decide()`。

`bindings()`、condition 或 `explain()` 抛错时，本次判定以 `policy-failed` 拒绝；计算快照时，`bindings()` 抛错即该 principal 没有 grant，condition 抛错即该 action 不放行。有问题的规则因此不会破坏共享的 `$events` 事件源、快照流或页面渲染。每次 `invalidate()` 以及每次 policy 注册或撤回之后，服务日志对每个 policy 只报告第一次失败；此后该 policy 的失败不再记录，直到下一次上述变化。

转发事件按其转发条目的读取函数指明的资源（条目未声明时为 `global`）判定 action `event:<name>`，对非 owner 整条送达或整条不送，从不裁剪 payload。事件携带其声明的每个资源，因此读取函数返回 `undefined` 时该事件的资源非法，Gateway 不询问 `decide()`，不送达任何非 owner。一个事件至多指明一个资源，因此集合类变化走 follow 类流（`session/follow`、`session/control`、`workspace/follow`），由这些方法内联经 `allows()` 逐项判定。

本服务经 `webserver/index-inject` 为 webServer 渲染的每个 index 加入名为 `REMOTE_ACCESS_SNAPSHOT_KEY`（`__DSH_REMOTE_ACCESS__`）的 `global` 行，值为该次渲染所代表 Peer 的 `snapshotFor(peer.principal)`：owner 的浏览器页面以 `{ type: 'baseline', owner: true }` 打开，为非 owner Peer 渲染的页面（例如在 owner Host 上渲染的 liveshare 读者页）以该读者的 grant 打开。Client 入口在挂载时读取该全局。

| `remote-access/denied` 的 `details.reason` | 原因 |
|---|---|
| `resource-invalid` | 由 Gateway 在 `decide()` 之前给出：资源读取函数抛错或返回空列表，或某个资源 id（含 Context 身份）不是非空字符串。 |
| `no-allow` | 该 principal kind 没有 policy，或在某个资源上没有 binding 放行该 action，且 condition 与 `explain()` 都没有给出原因。 |
| `policy-failed` | `bindings()`、condition 或 `explain()` 抛错；该失败按上文规则记录日志。 |
| condition 或 `explain()` 的原因 | 在第一个没有 binding 放行的资源上，取匹配 binding 中第一个拒绝的 condition 的原因；没有时取 `explain(request)` 的返回值。 |

快照 grant 按该 principal 的 binding 所指的每个资源，列出这些 binding 的 role 中、经 `decide()` 在该资源上不带调用参数放行的端点 action（已排序），因此在同一 principal、action 与资源上快照与 `decide()` 一致；没有此类 action 的资源不出 grant，放行集合变空时推送 `remove`。`event:` action 不进入快照。快照只在 `invalidate()` 与 policy 注册或撤回之后重算。

<a id="client-face"></a>
## Client 面

Client 入口同步读取 index 注入在 `REMOTE_ACCESS_SNAPSHOT_KEY` 下的 baseline，经 `mountAccess(ctx, contribution, initial)` 自行挂载生成的 `remoteAccess` contribution，订阅快照流，并提供：

- Client 服务 `ctx.remoteAccess.source(kind, id, action)`，为已声明种类的某个资源上的每个 `(kind, id, action)` 提供一个身份稳定的布尔 source；
- `ctx.remoteAccess.whenAccess(action, callback)`，在 `global` 资源允许 `action` 期间保持回调的效果：答案变为 true 时执行回调，变为 false 时逆序撤销其效果，下一次变为 true 时再次执行。回调返回一个 disposer 或一组 disposer，与 `ctx.slots.inject` 相同；答案已为 true 时（owner 恒为 true）回调同步执行；控制器属于调用方 fiber。允许期间的安装失败立即抛出；之后的安装失败使控制器停止，并在微任务中重新抛出。`whenResourceAccess(kind, id, action, callback)` 对已声明种类的某个资源做同样的事；
- 标准 Hook `useRemoteAccess(action)`，回答 `global` 资源上的访问。

领域 UI 包在 `source()` 之上发布各自资源的 Hook，在 `whenResourceAccess()` 之上发布各自的 `whenAccess`：[ui-session](../../client/ui-session/README.zh.md) 提供 Session 资源上的 `useSessionAccess(sessionId, action)`、会话作用域的 `useAccess(action)` 与 `ctx.uiSession.whenAccess(sessionId, action, callback)`（与 `global` 资源上的 `useRemoteAccess` 不同名），[ui-workspace](../../client/ui-workspace/README.zh.md) 提供 Workspace 资源上的 `useWorkspaceAccess(workspaceId, action)` 与 `ctx.uiWorkspace.whenAccess(workspaceId, action, callback)`。只有拥有某个资源种类的包才调用 `source()` 与 `whenResourceAccess()`；其他插件经访问 Hook 与各 `whenAccess` 读取访问。Hook 的 `action` 类型为 `RemoteEndpoint`，即某个 Client Remote namespace 声明的端点。非 owner 的答案是该资源的 grant 是否列出该 action，不回退 `global` 答案，因此没有 grant 或 grant 未列出任何 action 的资源回答 false。owner 的所有答案为 true；没有注入 baseline 的非 owner 页面、快照流终止失败的非 owner 页面，所有答案为 false；终止失败会连同错误一并报告，非 owner 附“刷新页面重连”的提示，owner 附“答案不受影响”的说明；重连期间保留上次快照。注入的 baseline 格式错误时挂载失败。Hook 从不发请求，Host 仍检查每次调用。[`dsh-client-test-runtime`](../../test-support/client-runtime/README.zh.md) 在 Client spec 中以固定答案（默认全允许）的访问替换本行。

<a id="model-experience"></a>
## 模型体验

无：本包为 Client 调用方判别 Remote 访问，不注册任何面向模型的内容。

#### KV Cache 影响

无直接影响。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 快照与列表过滤的判定不带调用参数，因此按 `args` 细化结论的 condition 可能拒绝快照显示为允许的调用。
- 资源读取函数与自动解析必须覆盖方法访问的全部资源；调用未指明的资源不受检查，持有已指明资源授权的 principal 可以访问它。
- 默认资源解析按 wire 字段名匹配；给方法新增与已登记种类同名的字段，会让调用多访问该种类的资源。
- exact Connection Fetch route 不经过 Gateway；在各路由声明自己的访问规则之前，共享 Fetch handler 对所有非 owner Peer 返回 403。
- 交互参与（回答转发的 waterfall）仅限 owner：非 owner 的 `$events` 流只收到 policy 在事件资源上放行其 `event:<name>` action 的广播帧。
- `api-session/added` 携带完整的 `SessionSummary`，因此被允许接收它的非 owner 也会得知其 `parentSessionId`。
- 被授权 Session 的 cwd 与工具路径本就包含 owner 的绝对路径，因此 `$events` ready 帧向非 owner 提供完整的 `host`（含 `home`）；Gateway 不单独隐藏 `home`。
- policy 撤销某个 Workspace 的可见性后，`workspace/follow` 只在该 Workspace 或 Workspace 顺序下一次变化时察觉并重推非 owner 的 baseline；仅访问变化不会发送帧。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
