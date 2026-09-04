# Agent Note: Session-log snapshot corpus

Status: implemented

[English](2026-08-24-session-log-snapshot-corpus.md) | 中文

## Problem

无密钥快照语料通过 ACP 控制许多场景，但这些场景断言的行为实际属于组装后的 Agent、工具、持久化或其他产品接口。这使自动化协议看似拥有后端行为，同时在受支持的 `dsh` 启动器之外保留了测试专用应用入口，并将录制会话分散在示例、SDK、Web 和脚本目录中。

快照一词也用于互不相关的 ARIA、几何、生成器和包级单元测试预期输出。贡献者无法从路径判断测试是否由录制会话驱动、会话是否同时作为回放输入和预期输出，或哪个命令负责刷新。

## Decision

顶层 `snapshots/` 树和 `*.snapshot.ts` 后缀只用于拥有或显式引用录制会话 JSONL 的场景。每个进程级场景都通过 `dsh` 启动一个随附 profile；小型适配器控制 headless、SDK、ACP 或 Web 行为，但不成为另一个应用入口。声明式 `snapshot.yml` 只保存已完成会话无法表达的 profile、patch、生命周期控制、平台、header pin 和 workspace 事实。

本决策取代[一次录制／确定性回放决策](2026-06-19-acp-snapshot-tests.zh.md)中 ACP 专属的放置位置与控制器所有权；后者继续负责会话日志回放、例外 override、规范化和 ACP transcript 比较。

录制会话仍是主要输入和预期输出。来自用户的消息驱动所选公开接口，录制的 assistant chunk 驱动确定性模型回放，规范化后的持久化结果必须等于 fixture。父会话和子会话共享同一类型化脱敏映射。提交的 fixture 使用保留关系的身份 token，并将请求 system prompt 和工具 schema 替换为 token；每个不同 header 类仍保留一个显式 sidecar 所有者。

Fixture 解码与比较只取决于选定 JSONL 内容；文件名标识 inventory role，但不是 parser 输入。replay、seed、record、refresh 与规范化比较路径都使用同一个严格静态 catalog 校验。

Headless stderr 重建会同时展开 `assistant/message` 与仅写入日志的 `assistant/attempt` settlement 中嵌入的 reasoning，因此失败或重试尝试的 reasoning 仍属于进程输出投影。

每个 parent 或 child 角色都使用 `session[.<ordinal>][.vN].jsonl`；v0 省略版本，且每个文件名都与其 header 一致。回放、录制与刷新按角色选择数值最高的 generation。大多数 owner 省略 `sessionFormat` 并跟随当前 writer；受限的历史 owner 会声明精确版本与封闭 coverage 名称。v2 语料保留选定 v0 角色，覆盖多跳、打包行、重试／失败与随附 profile，并保留选定 v1 角色覆盖相邻结构 edge。录制与刷新绝不改写显式保留的历史 fixture、重命名已提交 generation 或通过自动清理删除 generation。保留 Session generation 不会冻结非 Session 预期输出：refresh 仍会根据当前 run 写入 owner 持有的 system-prompt 与 tool-schema sidecar。受审阅的源树整理只有在同角色存在已验证的当前后继后才移除前代。语料策略要求选定当前角色始终占多数，并将选定历史角色上限设为十个；更低的前代 generation 可以保留在选定当前后继旁。

场景拥有的 HTTP fixture 将会话中录制的稳定 authority 与传输 listener 分离。每个 fixture 在回环地址上绑定端口 `0`，由操作系统以一次原子操作分配并绑定端口，再将录制的 URL 或 endpoint 通过真实 provider 映射到该 listener。任何进程全局传输拦截只匹配录制 endpoint，由 fixture fiber 拥有，并在关闭 listener 前恢复。

每个现有 ACP 场景都获得一个保留行为的目标。普通单次行为使用 headless profile，需要持久机器控制的行为使用 SDK profile，只有 ACP 协议行为继续归 ACP 所有。由录制会话驱动的 Web 场景加入该语料，并保留其 ARIA 或几何预期输出作为辅助证据。没有录制会话来源的 Web 和包级测试保留归属方本地的预期输出，并停止使用快照路径或文件名。

Workspace 输入继续归各场景本地所有。变更文件的场景比较完整的预期最终 workspace，record 与 refresh 绝不改写该预期，因此模型或工具的自报结果无法满足测试。现有的有意会话复用继续使用显式、无环的所有者引用；语料不增加 workspace 继承或通用 fixture 合并机制。

## Alternatives considered

**继续将 ACP 作为通用驱动器。** 这会保留现有 harness，但继续把后端覆盖耦合到低优先级协议，也无法证明受支持的 headless、SDK 和 Web 启动路径。

**将每个场景移动到新的 headless 测试驱动器。** 私有驱动器会重现应用入口问题，也无法表达随附 SDK profile 已提供的多轮、取消或后台生命周期控制。

**将每种预期输出集中到 `snapshots/`。** ARIA、几何、生成器和单元测试预期不会把录制会话同时用作输入和结果。混合这些内容会保留当前含糊的术语，并削弱包所有权。

**创建统一的声明式浏览器和终端语言。** 复杂 UI 和 PTY 场景需要交互代码。共享快照核心加接口适配器可以移除应用驱动器，而无需增加第二套测试框架。

**自动去重 workspace 和录制会话。** 当前 workspace 重复很少，有意保持本地性更易审查。只有现有的语义会话复用值得显式引用。

**直接绑定录制 URL 的数值端口。** 稳定 listener 端口使传输值与 transcript 值一致，但同一主机上的并发快照 job 共享网络命名空间，会争用该端口。

**在启动场景前探测未使用端口。** 子进程绑定前释放已探测端口会产生检查时间与使用时间竞态。在拥有该端口的进程内绑定端口 `0`，可使分配与所有权保持原子性。

**让每个选定 fixture 都使用当前版本。** 这会减少 fixture 版本，却移除随附 profile 对完整相邻迁移链仍可还原已发布输入的证明。

**让每个场景都继续选择其最旧 generation。** 这会最大化迁移调用，却使快照语料不再把当前 writer 与当前格式快速路径作为普通情况来覆盖。

## Invariants

- 每个现有录制会话场景都在移除旧所有者之前拥有一个通过的替代场景。
- 每个进程级快照都通过 `dsh` 启动，应用入口清单不再允许已退休的快照驱动器。
- 每个顶层场景都拥有或引用会话 JSONL；非会话预期输出继续归所有者本地所有。
- 提交的会话 fixture 是脱敏固定点，不含 system prompt 或工具 schema 正文，并为每个 header 类保留且仅保留一个 pin。
- 规范 fixture 名称与其 header 版本一致；每项引用都指向 owner 选定的 parent generation；最多十个选定角色使用显式 v0/v1 声明，选定当前角色多于这些历史角色，且后者的 coverage 名称涵盖每项保留的迁移行为。
- 变更内容的场景从外部验证最终 workspace。
- 所属位置的进程预期使用 `*.expected.e2e.ts`，并由单独的构建产物门禁运行。
- 源码与构建适配器在隔离的 profile fallback 中安装仅回放包；不同的提示词 section 顺序值使两种模式的请求 header 保持字节一致。
- 场景 HTTP fixture 绑定由操作系统分配的回环端口，同时保留录制的模型可见 authority。
- 源码和构建启动模式、浏览器回放、SDK 投影、打包 Python 运行时场景、文档门禁和仓库卫生检查通过。

## Consequences

该语料让控制器所有权可见：普通 Agent 行为不再继承 ACP 协议输出，SDK 和 Web 投影保留各自接口专有的证据，只有 ACP 取消与权限交换仍归 ACP 所有。贡献者审查一份规范化会话差异，以及提供独立证据的 sidecar 或 UI 预期。新增组合必须提供 manifest 类别 pin；新增易变身份必须添加保留关系的带类型脱敏规则，而不是扩大文本清洗范围。并发 job 可以回放依赖网络的 fixture，而无需预留仓库级端口，代价是 fixture 内需要维护录制 authority 与传输 listener 的映射。

历史迁移覆盖的代价是显式逐场景元数据与保留的前代文件；选定当前角色占多数则防止兼容性 fixture 隐藏当前 writer 回归。

## Risks

语料可能变更数百个 fixture，generation 名称改动可能掩盖行为变化。因此，diff 与验证必须能分别归属机械 generation 输出、规范化行为与控制器行为，预期输出改写需要逐场景审查。

将一份录制会话同时用作回放输入和预期输出，可能会稳定复现错误的模型脚本。独立的世界状态断言、协议或 UI 预期、真实模型录制和聚焦包级测试仍是必要的补充证据。
