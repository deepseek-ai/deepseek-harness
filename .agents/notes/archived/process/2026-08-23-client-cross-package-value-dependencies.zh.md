# Agent Note: Client 跨包值依赖分类

Status: implemented
Archived: 2026-09-04

[English](2026-08-23-client-cross-package-value-dependencies.md) | 中文

## 问题

[PR #2728](https://github.com/deepseek-ai/deepseek-harness/pull/2728) 与 [PR #2911](https://github.com/deepseek-ai/deepseek-harness/pull/2911) 拆分 Client 包后，功能插件 manifest 中还留有 15 条 `dsh.client.external` 请求。即使消费方只需要一个类型、一段小型纯转换或访问已经注入的 Cordis service，这些请求也会把普通值 import 变成同步模块表顺序约束。

机械删除所有 import 会产生别的耦合：通用工具包可能变成杂项业务 owner，service 可能承载纯展示转换，或者只为通过重复检测而把 target 行为集中到一处。维护 Client 时，需要先用同一套流程分类，再决定跨包引用应当放在哪里。

## 决策

每条 Client 跨包引用都按实际跨越包边界的内容分类。功能插件不从另一个功能插件导入运行时值，也不声明 `dsh.client.external`。[Client shell 分层决策](../architecture/2026-08-15-client-shells-and-dynamic-packages.zh.md)继续负责 bundle 构建与模块表加载；本决策进一步限定功能代码如何使用这些机制。

| 情形 | 处理方式 | 原因 |
| --- | --- | --- |
| 未使用的值或转发 export | 删除 | 没有调用方的依赖不需要保留 owner。 |
| 共享声明 | 从声明方包使用 `import type` 导入 | 被擦除的 import 保留单一类型权威，但不产生运行时边。 |
| 有状态、受生命周期约束或可调用的功能行为 | 通过注入的 Cordis service 暴露 | 提供插件拥有实现与生命周期；消费方只依赖 service 名称和接口。 |
| 展示贡献 | 通过声明方 slot 注册 | owner 控制放置位置，各贡献方仍可独立加载。 |
| 通用无状态辅助函数或基础组件 | 放入窄职责静态工具包或 `ui-primitives` | 只有不持有功能状态、生命周期或领域权威的行为才允许被多个包同步共享。 |
| 小型 target 专属投影 | 每个 target 保留一份本地实现 | Chat 与 Trajectory 可以独立解释同一持久事件；仅仅复用代码不足以证明应建立功能依赖。 |
| 生成的 Remote 产物 | 只在拥有生成注册的 API 传输组装层导入 | 生成的 provider 是传输接线，不是功能包的可调用辅助 API。 |

有意保留的 target 本地副本只用 `jscpd:ignore-start`／`jscpd:ignore-end` 包住重复实现，并在注释中点名相互独立的 owner；排除范围不得覆盖周围业务逻辑。只有语义独立于所有当前调用方时，通用行为才进入工具包；本次清理把 Workspace 路径格式化放入 `dsh-util-workspace-path`，把字节编码放入 `dsh-util-crypto`，把共享引用图标放入 `ui-primitives`。

`verify-client-packages` 拒绝 `packages/client/*` 下的所有 `dsh.client.external` 声明。在该功能树之外，每条声明都必须对应生产代码中的运行时 import 或 re-export。保留的两条请求是 Session Controller → API Gateway 与 Workspace Controller → API Gateway，二者都属于传输基础设施。Client bundle preset 还会拒绝既非模块表请求、也未被明确加入静态输入 allowlist 的 workspace 运行时 import。

面向 Host 的传输适配器不属于功能插件禁令。Connection 可以使用 API Proxy 的 carrier 实现，`api/remotes` 可以加载生成的 Host Remote provider；这些 import 用于组装传输，而不是共享功能行为。

## 考虑过的替代方案

**把所有复用值都放到 `uiConversation`。** 否决，因为纯 event→view 转换会变成 service 调用或功能 export，迫使 Chat、Trajectory、Approval、Question、Subagent 与 Workspace 加载一个无关的功能 owner。

**保留功能插件的 `dsh.client.external` 声明。** 否决，因为加载成功只会把同步值依赖的顺序显式化，不会消除该依赖。

**把每个重复函数都移入同一个工具包。** 否决，因为 target 专属解释会因此获得一个虚假的共享 owner。只有语义独立于调用方的无状态行为才属于静态工具。

**忽略全部 Client 重复代码。** 否决，因为重复默认仍是有用信号。每项 ignore 必须范围狭窄，并说明哪些具名 target 需要有意保持独立。

## 后果

15 条功能插件 external 请求已移除，共享声明 import 保持显式且仅类型化。功能加载顺序由 Cordis service 与 slot 决定，不再由同步功能模块 import 决定。

少量投影函数存在两份实现。各 owner 可以独立演进，重复检测仍覆盖注解副本以外的全部代码。静态工具包增加少量公共 API，并且必须保持无状态且可在浏览器运行。

这项规则按包角色区分，并非全面禁止跨包值。加载或协议组装需要的基础设施适配器与生成注册产物仍保留直接 import，`verify-client-packages` 则确保这些例外保持可见且确实仍被使用。
