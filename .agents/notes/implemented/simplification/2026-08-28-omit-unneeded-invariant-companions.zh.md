# Agent Note: 没有独立观察时省略不变量伴生入口

Status: implemented

[English](2026-08-28-omit-unneeded-invariant-companions.md) | 中文

## 问题

包不变量规则曾要求每个工作区包都发布 `./invariant`，包括没有运行时关系可检查的包。当前工作区有 209 个带说明的空伴生入口，每个入口都带来源文件、公共导出、发布项、仅供不变量使用的依赖或 TypeScript 引用、构建接线与注册测试。这套机制只表达否定结论，没有增加运行时断言。

`dsh-host-webserver` 伴生入口以可执行形式暴露了同一问题。它会在插件生命周期事件上注册并释放合成保留路由，再次调用同一组服务操作来检测残留。该探针没有独立产生的观察：它通过自己要验证的实现修改并检查同一张路由表，而真实路由与 HMR 测试已经覆盖重复拒绝和 disposer 对称性。

## 决策

### 独立观察是发布条件

只有当包能够比较可能独立产生分歧的观察时，才发布 `./invariant`。符合条件的关系包括跨事件生命周期、顺序、身份或配对协议；事件与权威可变状态的对照；多个生产方或 adapter 组装的输出；以及由另一个操作后续折叠或消费的持久数据。

服务或方法是否存在、插件 metadata 或 effect、固定纯函数示例，以及调用同一变更操作来验证该操作的探针，仍属于类型、加载、单元或集成测试。parser 与 config 输入、模型或工具 JSON、持久文件、worker 与进程消息和 wire 输入，仍在拥有其输入的操作处校验。

`dsh-time-context` 伴生入口继续发布。它把插件产生的 context message 与独立拥有的当前轮用户消息 provenance 和持久事件时间进行对照，因此即使 formatter 本身正确，attribution、轮次位置与 elapsed-time 关系仍可能产生分歧。

### 在包 README 中明确省略

没有符合条件的关系时，包会省略 `src/invariant.ts`、`./invariant` 导出、`lib/invariant.js` 发布、仅供不变量使用的依赖与 TypeScript 引用、构建入口和伴生入口专用测试。中英文包 README 会说明不发布伴生入口，并记录该包的具体原因。仓库会拒绝空 installer，因为不存在源文件加 README 说明可以直接表达该决策。

`verify-package-invariants` 会扫描每个包。它要求英文 README 记录包级省略原因，拒绝不完整的导出、发布或伴生入口构建接线，拒绝空 installer，并对每个已发布伴生入口执行注册、Loader namespace、reporter 使用、依赖、引用与构建检查。Vitest Host 只在当前包存在伴生入口时挂载它，拓扑与构建产物检查则枚举已发布集合。

### 审计结果

全仓库审计删除了 209 个带说明的空伴生入口和合成的 `dsh-host-webserver` 伴生入口，留下 39 项比较独立观察的检查。保留项包括 session、command、approval、workflow 与 hook 生命周期等跨事件协议；settings、storage-domain、Workspace、client modules 与 slots 等事件到状态检查；system prompt 与 time context 等多生产方组装检查；以及 todo、plan mode 与 sandbox mode 等由 projection 或 policy state 消费的持久数据。

被省略关系继续由现有包行为测试负责，包括 webserver 路由注册与 HMR 释放。产品行为与包根入口不变；被省略的 `./invariant` 子路径按照仓库的预发布兼容策略移除。

## 考虑过的替代方案

- **保留带说明的空伴生入口。** 不采用：源文件、公共子路径、依赖边、构建输出和测试是一套过于繁重的机制，不应只用来表达不存在检查；包 README 可以直接记录该结论。
- **把 webserver 探针保留为清理 sentinel。** 不采用：它会在无关生命周期事件上修改保留路由，并且只验证自己调用的服务方法。真实路由与 HMR 测试可以在没有生产诊断 effect 的情况下覆盖该行为。
- **把每个生产方格式 parser 都视为自校验。** 不采用：即使文本只有一个生产方，parser 仍可能对照独立 provenance、时间或持久历史。`dsh-time-context` 符合条件，因为其消息会与当前轮用户消息和持久事件时间对照；只对同一写入方的 payload 做往返检查不符合条件。
- **要求每个拥有私有可变状态的包都发布伴生入口。** 不采用：没有独立事件或第二数据源的私有状态只能通过重复实现来检查，或者需要专门为诊断暴露新 API。

## 后果

- 拥有有意义检查的包保留可独立加载、过滤并归属到包的伴生入口。
- 没有检查的包不再承担不变量源文件、公共子路径、构建产物或仅供不变量使用的依赖，其 README 会保留原因。
- 新增可变关系或被消费的事件协议时，必须重新审视省略结论、更新 README，并添加带负向测试的聚焦伴生入口。
- 不变量服务的配置、归属唯一性、子 fiber 生命周期、过滤、回滚、dispose 与 HMR 约定保持不变。
- 早期的[有意义运行时约定决策](../architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)仍是语义检查质量的权威依据；本决策取代其中的穷尽发布与带说明空入口形式。
