# Agent Note: Inspector 执行环境与协议平面

Status: implemented

[English](2026-08-26-inspector-execution-realms-and-protocol-planes.md) | 中文

## Problem

Inspector 包的代码运行在三个 JavaScript 环境中：浏览器 Client、Host Node 主线程和 Inspector Worker thread。只按功能命名目录时，文件路径无法说明代码在哪里运行，也无法说明它可以持有哪些标识符。

这种含糊会带来风险，因为 Host 与 Client 的支持能力有意不同，但架构必须保持可比较。Host Runtime 与 Debugger 委托 Node inspector protocol；Client Runtime 与 Console 通过内部 bridge 模拟同一套 backend 语义。如果两边的文件、接口与 unsupported operation 在结构上分叉，每增加一种协议方法都容易产生第二套路由模型。同样，只需要 Cordis 运行时树的消费方不应继承 debugger activation、Chrome 连接状态或 CDP 标识符。

现有的[跨 realm CDP Inspector 决策](2026-08-23-cross-realm-cdp-inspector.zh.md)负责 Worker、transport、Runtime、debugger 与安全行为。[Cordis 运行时树检查决策](2026-08-24-cordis-runtime-tree-inspection.zh.md)负责 Cordis 树语义、对象路由与 DOM projection。本决策负责源码位置、依赖方向，以及领域数据、backend 语义、内部 transport 和 Chrome CDP 状态之间的分隔。

## Decision

顶层源码目录标识执行归属。`client/` 只包含浏览器 Client 代码，`host/` 只包含 Host Node 主线程代码，`worker/` 只包含 Worker thread 代码，`shared/` 只包含在所有环境中都安全的代码。即使某个模块代表 Client，只要它实际在 Worker 中执行，就仍属于 `worker/`，而不是 `client/`。

仓库要求的 `src/index.ts` 发现入口是本包唯一的源码根目录例外。它暴露 Host package entry 及其 service type，不包含 Inspector 运行时实现，并为仓库工具保留在固定路径。本包不发布 invariant companion，因为其关系会在所属 wire、generation、Worker 或 CDP 操作中失败，原因记录在 README 中。

```text
src/
  shared/   environment-independent data and interfaces
  client/   browser Client producer and adapters
  host/     Host Node-main-thread producer and adapters
  worker/   Worker transport, repositories, realm backends, and CDP endpoint
```

`client/` 与 `host/` 拥有相同的相对目录和文件名。共同角色包括 plugin entry、bridge lifecycle 与 RPC、Cordis 和 network inspection，以及面向 CDP 的 Runtime、Console、Debugger、Sources、Profiler 和 HeapProfiler adapter。支持程度可以不同：不可用的操作仍保留在对应的镜像模块中，并返回共享的 capability-unavailable 或类型化 unsupported 结果。镜像结构统一的是能力实现位置，而不是宣称两个引擎支持相同功能。

Worker 侧 realm adapter 在 `worker/realms/client/` 与 `worker/realms/host/` 下遵守相同规则。这些 adapter 通过共享的面向 CDP backend 接口规范化 Client 模拟行为与 Node inspector 行为。它们不拥有 Chrome wire message 或连接局部的 CDP 标识符。

## Execution ownership

`client/` 负责 page realm observation、Client object handle、浏览器求值、浏览器 Console interception、Client source publication 以及到 Worker 的直接鉴权 bridge。它可以使用浏览器 API，但不能导入 Node 或 Worker 实现模块。

`host/` 负责 Node 主线程上的 Cordis plugin composition、Worker 启动与 dispose、Host object observation、fetch capture、Node inspector notification forwarding，以及 Worker bridge 的 Host 一侧。它可以使用 Node API，但不构造 Chrome CDP response。

`worker/bridge/` 负责 source admission、transport endpoint、connection generation、frame dispatch、correlation，以及 source producer 与 Worker consumer 之间的路由。`worker/inspection/` 负责保留的 Cordis 与 network observation，以及不依赖 transport 的 query。`worker/realms/` 负责规范化的 Host 与 Client runtime backend。`worker/cdp/` 负责 HTTP discovery、DevTools session、Chrome method dispatch、domain enable 状态与所有连接局部的 Chrome 标识符。

Worker 继续作为唯一的 Chrome CDP wire 与状态 owner。Client 代码模拟共享 backend operation，而不是模拟 CDP wire。Host 代码把支持的 backend operation 委托给 Node inspector，但 Node protocol 标识符在 Worker Host realm 内转换后才进入公共 domain projection。

## Data and identifier ownership

`shared/cordis/` 包含与 CDP 无关的语义模型、不可变 snapshot、collection 与 observation、realm-local object registration、projection 与 reader interface。`model.ts` 不包含 transport handle 或 CDP 标识符。`snapshot.ts` 可以携带 realm-local opaque object reference，因为实时对象查询需要该路由信息，但消费方可以在 projection 中移除它。

`shared/network/` 包含 fetch 与 network observation、采集 body 表示及 header normalization。这些记录描述已观测活动，不包含 CDP request id 或 domain enable 状态。

`shared/cdp/` 包含 realm capability、Runtime、Console、Debugger、Sources、Profiler、HeapProfiler 的规范化 backend 接口和值，以及类型化 unsupported 结果。这些接口中的 backend handle 是不透明且由 realm 持有的。它们不是 Chrome `RemoteObjectId`、`ExecutionContextId`、`ScriptId` 或 `CallFrameId`。

`shared/bridge/` 包含带版本的内部 carrier：source 与 generation 标识符、envelope、codec、validation、有限 publication、RPC correlation、dispatch interface 及分领域的 message union。其 message 模块可以传输 Cordis snapshot、network observation、Console event、Runtime operation、source read、debugger operation 与语义 query，但不会把这些值转换成 CDP message。

`worker/cdp/ids.ts` 是 Chrome 连接局部标识符的唯一 owner，包括 `RemoteObjectId`、`ExecutionContextId`、`ScriptId`、`NodeId` 与 `CallFrameId`。Worker domain session 分配并释放这些 id，把它们映射到 realm backend handle 或 inspection record。source、generation、sequence、request、Cordis Fiber uid、realm object reference、backend handle 与 Chrome id 必须保持为不同类型，因为它们的 owner 和生命周期不同。

## Dependency rules

领域模块 `shared/cordis/`、`shared/network/` 与 `shared/cdp/` 不导入 `shared/bridge/` 或任何执行环境专属目录。`shared/bridge/` 在定义内部 message 时可以导入这些领域类型。`shared/` 下的任何模块都不导入 Node-only 或 browser-only API。

顶层 `client/` 与 `host/` 可以导入 `shared/`，但不能互相导入，也不能导入 `worker/`。等价角色使用等价的共享接口。环境专属 transport 与 engine 行为保留在对应镜像实现文件中，不进入带条件分支的共享实现。

`worker/realms/` 与 `worker/inspection/` 可以导入共享接口，但不导入 `worker/cdp/`；规范化 backend result 和已存 observation 不能包含 Chrome connection state。`worker/cdp/` 可以消费 realm 与 inspection interface 来生成 CDP projection。`worker/bridge/` 路由共享 message 并调用 Worker service，但不成为 Cordis、network、Runtime 或 Chrome 状态的 owner。

本能力继续保留在同一个 `@deepseek-ai/dsh-experimental-inspector` 包中，并使用显式 Client 与 Host compiler face。目录分隔是执行与依赖规则，不是拆包方案。

## Verification

- 每个运行时实现都通过 `shared/`、`client/`、`host/` 或 `worker/` 拥有明确的执行 owner；只有仓库要求的 package 与 invariant 转发入口留在源码根目录。
- 顶层 Client/Host 树与 Worker Client/Host realm 树分别拥有相同的相对实现路径；不同能力支持使用显式类型表示。
- Cordis 与 network reader 无需导入 debugger、source、transport 或 CDP session 模块即可使用。
- 内部 message 包含 source 层 identity 与已验证领域值，但不包含 Chrome 连接局部 id。
- 规范化 realm backend interface 同时支持 Host 委托与 Client 模拟，且两种实现都不构造 Chrome CDP message。
- 只有 Worker CDP 模块分配 Chrome id，并持有 DevTools 连接的 enable、object、script、node 与 call-frame 状态。
- Host Runtime 与 debugging、Client Runtime 与 Console、Network capture、Cordis Elements projection、断联保留与语义 query 行为均有聚焦测试覆盖。
- compiler face、import check 与结构测试能够拒绝环境泄漏和 Client/Host 镜像漂移。

## Alternatives considered

**所有文件都按功能领域组织。** 拒绝，因为一个 Runtime 或 Cordis 功能会跨越三个可用 API 不同的环境。只有功能信息的路径会隐藏执行限制，也让 browser 到 Node 的意外导入难以审查。

**把 Worker Client 与 Host adapter 放入顶层 `client/` 和 `host/`。** 拒绝，因为这些 adapter 实际运行在 Worker 中，持有的资源也不同于 page 与 Node 主线程 producer。目录名应先回答代码在哪里运行，再回答它代表哪个远端 realm。

**Client 与 Host 目录只保留当前支持的文件。** 拒绝，因为不对称目录会隐藏缺失能力决策，并允许等价路由角色形成无关接口。显式 unsupported 实现既保证穷尽演进，也不虚构已支持行为。

**保留一个共享 protocol 目录。** 拒绝，因为内部 carrier identity、Cordis 语义数据、规范化 Runtime value 与 Chrome wire identifier 的消费方和生命周期不同。单一目录会诱导领域模型依赖 transport 和 CDP presentation。

**把 Client、Host、protocol 与 Worker 拆成多个包。** 实验阶段拒绝。部署单元仍是一个 Client/Host Cordis plugin；包边界会增加构建和发布协作，却不能改善所需的执行环境分隔。

## Consequences

严格镜像会为不支持的能力增加小型 adapter 文件。这些文件是两个实现之间有意保留的兼容点，但必须保持轻薄，也不能制造虚假行为。

即使只移动类型而不改变行为，也可能暴露隐藏的依赖环，尤其是 Runtime object annotation 访问 Cordis repository 的位置。依赖规则要求通过共享接口反转依赖，不能临时从较低层模块反向导入。

如果不加约束地添加规范化类型，`shared/cdp/` 可能变成第二份 Chrome protocol。只有两个 realm 实现或公共 Worker projector 会消费的类型才属于这里；Chrome session bookkeeping 与 wire-only field 保留在 `worker/cdp/`。

显式 Client/Host compiler face 与聚焦行为测试增加了维护工作，但会持续暴露环境泄漏和镜像结构漂移。
