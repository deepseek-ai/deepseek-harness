---
kind: upgrade-guide
description: "Store 接管的 Session 拒绝创建宣告完成前和移除后的写入。"
---
# Store 接管的 Session 在发布后开放写入

[English](guide.md) | 中文

## 变更

Store 接管的实例仅在进入 `SessionStore` 且同步 `session/created` 分发完成后，才能通过 `Session.append()` 和 `appendPluginRecord()` 写入，离开 Store 后再次拒绝写入。Store 从 `prepare()` 或 `enter()` 开始接管实例。创建监听器不能追加，宣告失败后仍不能写入。独立的 `Session.create()` 和 `Session.fromRestore()` 实例仍可写入，且不通知 Store 观察者。构造、恢复和 fork 历史仍可正常加载。Agent 工厂在调用 setup 前完成 `session/created`，`agent/created` 仍在 setup 后执行。在 `session/created` 期间，`ctx.agents.get(session.id)` 现在返回 `undefined`。setup 内注册的监听器会错过其所属 Session 的创建宣告。setup 事件现在除了进入持久化历史，也会传递给 Session 的实时订阅方。

setup 失败后会保留已经写入持久化存储的构造历史和 setup 事件。因此，带 seed 的创建（包括 fork）失败后可能留下已存储的 Session，其标识不能再用于新建。

权限默认值在 `agent/created` 中初始化，因此只创建 Session 不再固定这些默认值。`dsh-permission-presets` 除既有依赖外，现在还要求 `agents` 服务。

## 迁移

1. 使用 `ctx.sessions.create()` 创建由调用方 fiber 拥有的可写 Session。若显式拥有生命周期，依次调用 `prepare()`、`enter()` 和 `announce()` 后再追加；保留返回的 disposer，直到所有收尾事件完成。
2. 独立日志构造继续使用 `Session.create()` 和 `Session.fromRestore()`。在把实例交给 `enter()` 前构造历史，或把历史作为 seed 传给 `prepare()`。移除不会恢复独立写入权限。冷日志的持久化写入使用持久化写句柄。
3. 将写入和依赖 Agent 的工作移出 `session/created` 监听器。在 setup 或 `agent/created` 中写入；使用 setup 提供的 Agent 或 `agent/created` 载荷，不要在 Session 宣告期间查找 Agent。
4. 将 setup 内监听所属 Session 的 `session/created` 的代码改为监听 `agent/created`。需要观察 Session 创建时，应在工厂创建开始前安装监听作用域。
5. 创建失败但已持久化历史时，使用 `ctx.agents.resume({ resumeSessionId })` 重试，不要对同一 id 再次调用 `create()`；保留存储历史用于恢复。
6. 挂载 `dsh-permission-presets` 的自定义 profile 也必须挂载提供 `agents` 的 `dsh-agent`，并等待权限插件激活后再创建 Agent。
7. 验证创建观察者看到预期的注册表状态、权限完成初始化、创建失败后能恢复存储历史，以及被拒绝的追加不会改变历史。
