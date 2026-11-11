# Agent Note: 稳定 API 规范

Status: proposed

[English](2026-11-05-stable-api-policy.md) | 中文

## Problem

DSH 的所有公开 API 都处于预稳定（pre-stable）阶段：根目录 `AGENTS.md` 要求 API 变化时同步更新每个消费方。这条规则在仓库内部可行，但外部插件现在从 npm 和插件市场安装，作者无法判断哪些 API 可以依赖。所有发布的包共用一个锁步版本，包版本无法说明哪个 API 变了。唯一的兼容检查是 [plugin-compatibility.ts](../../../../packages/boot/app-boot/src/plugin-compatibility.ts) 中的 `evaluatePluginCompatibility`，它把插件的 `engines.dsh` 范围（没有时改用 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` peer 范围）与整个运行时版本比较；`workspace:` peer 范围视为当前运行版本。

源码中没有区分 stable 与 unstable API 的标记。导出不带 `@public`、`@beta`、`@stable` 或 `@since` 标签；`@internal` 出现约十次且含义不一，不带日期的 `@deprecated` 出现约十几次。唯一严格的兼容规则针对数据格式（[Session 格式状态](../../../../docs/session-format-status.zh.md)、SQLite schema 版本、持久化类型变更确认）和 [upgrade guide](../../../skills/dsh-create-upgrade-guide/SKILL.md)。

规范必须从这一现状起步。贡献者不需要先给所有 API 定级，规范才能生效；没有人标记的代码保持现有工作方式。

## Proposal

源码中的稳定性标记是唯一输入。生成的 API 报告把标记转换为每次发布的带版本稳定 API 列表。版本单位是[能力 seam](../../../../docs/glossary.zh.md#capability-seam)。未标记的内容一律保持 unstable，因此可以逐个成员推进。

### 稳定级别

| 级别 | 标记 | 变更规则 |
|---|---|---|
| unstable（默认） | 无 | 随时修改，更新每个消费方，外部可感知的破坏性变更写入 upgrade guide |
| stable | `@stable <seam>@<version>`，即加入该成员的 seam 版本 | 只允许向后兼容的新增；删除或不兼容修改需要弃用期已满，并升级 seam 主版本 |
| internal | `@internal` | 仅在本仓库内部使用；不进入 API 报告；随时修改 |

弃用是 stable 成员的一种状态，不是第四个级别：带 `@deprecated <替代项或“无替代”>` 的成员在弃用期结束前仍是 stable。unstable 成员上的 `@internal` 和 `@deprecated` 标签保持现有含义；本规范不给现有标签赋予新含义。

[`packages/experimental/`](../../../../packages/experimental/README.zh.md#status) 下的包不能包含 stable 成员；包须先移出 experimental 分组，其中的成员才能晋升。

### 单位：一个能力 seam

每个能力 seam 有自己的 API 版本，与锁步的包版本无关。stable 成员属于声明它的 Service Definition 包所在的 seam；`Context`、`SessionEventMap` 等声明合并接口的成员属于添加该成员的包所在的 seam。不属于任何 seam 的导出（如工具函数、CLI 选项、SDK wire 协议）保持 unstable，留待后续提案归属。只能通过 `./src/*` 导出子路径访问的成员是 unstable。

声明 Service Definition 的包在现有的 `package.json` `dsh` 声明中登记 seam 版本，该声明由[公开包 manifest](../../implemented/architecture/2026-09-10-public-package-manifest.zh.md) 决策负责。一个包可以声明多个 seam，因此该成员是列表：

```json
{ "dsh": { "apis": [{ "name": "agent", "version": "1.0.0" }] } }
```

新成员是可选的，不改变 `manifestVersion`；成员名称尚未确定。按该决策的要求，报告生成器和兼容检查各自校验自己读取的成员。

### stable 覆盖的范围

stable 覆盖类型签名、事件顺序和 waterfall 调用约定（包括 listener 是否必须调用 `next()`）。本提案不覆盖默认配置值和配置字段。CI 根据生成的报告检测签名变化。行为变化无法可靠地自动检测；作者在 PR 描述中声明，由正常评审核对。锁定 stable 事件顺序和 waterfall 约定的测试属于 Service Definition 包，针对随产品发布的 Service Provider 运行。

stable 签名可以引用其他 seam 的类型，例如 `SessionId` 或 `Scoped`。这些被引用的类型成为引用方 seam 承诺的一部分：报告把它们列在该 seam 下，对它们的不兼容修改与修改该 seam 自身成员一样触发检查失败。

### API 报告与 CI

一个脚本生成并提交一份 API 报告，覆盖导出、Cordis 服务和事件，每个条目带有所属 seam、级别和版本；它取代已推迟的 [API extractor 报告](2026-06-11-api-extractor-reports.zh.md)提案中每个包一份的报告。每次发布归档当次报告。CI 把 stable 条目（包括被引用的类型）与最近一次发布的报告比较，以下情况失败：

- stable 条目被删除或不兼容修改，但没有升级 seam 主版本并写 upgrade guide；
- 被删除的条目没有在已发布的报告中标为弃用，或自首次记录该弃用的发布起弃用期未满；
- 新增 stable 条目，但没有升级 seam 次版本；
- stable 签名引用了标为 `@internal` 的成员，或本 seam 的 unstable 成员。

从首次记录弃用的发布开始计算弃用期，使其不依赖作者填写的日期。unstable 条目的变化只出现在报告 diff 中，不会让 CI 失败。CI 还会在 PR 中发布 stable API 变更摘要。晋升和破坏性变更在正常 PR 评审中批准，不指定专门的 API owner 或委员会。

### 插件作者告警

一条类型感知的 lint 规则报告对 unstable 成员的使用：解析每个被使用的符号，并从发布的类型声明中读取其级别。事件和 waterfall 名称是传给 `ctx.on()` 等调用的字符串字面量，因此规则要把它们与事件映射对应起来；[.oxlintrc.json](../../../../.oxlintrc.json) 中的 `typescript/no-deprecated` 不覆盖这种情况。oxlint 不支持自定义的类型感知规则，因此该规则以发布的工具形式提供，插件作者在自己的构建中运行；仓库对 stable 的 Service Definition 包运行该规则。子路径导出隔离（`…/unstable` 入口）已否决，见 [Alternatives considered](#alternatives-considered)。

### 插件依赖声明

插件可以声明所需的 seam 版本，例如 `"dsh": { "requires": { "agent": "^1.0.0" } }`。seam 检查是附加的：`evaluatePluginCompatibility` 仍然检查 `engines.dsh` 或 DSH peer 范围，同时把列出的每个 seam 范围与当前 Host 的 API 报告中记录的 seam 版本比较。声明了 seam 范围的插件可以把 `engines.dsh` 放宽到它支持的所有运行时。插件市场索引条目和 registry 更新检查读取同一声明，使发现、安装和更新得出相同结论。按约定，插件还列出它使用的 unstable seam；Host 无法验证这份列表，插件管理页把它显示为风险。该声明不限制插件能导入或访问什么：Cordis 插件在 Host 进程内运行，可以导入任意包或访问 `ctx` 上的任意服务。

### 兼容层

为旧插件提供旧的 seam 主版本暂缓实现。当某个 stable seam 升级主版本、而外部插件仍依赖上一个主版本时，兼容层才有价值。届时 Host 只保留一份当前实现，由适配插件在其上提供旧的 Service Definition，并设定固定支持期限。

### 落地步骤

1. 仅规范：合入本 Agent Note 并确定弃用期。把根目录 `AGENTS.md`、[packages/README.md](../../../../packages/README.zh.md)、[packages/experimental/README.md](../../../../packages/experimental/README.zh.md)、[apps/cli/reference/README.md](../../../../apps/cli/reference/README.zh.md) 以及由 [gen-plugin-packages.ts](../../../../scripts/gen-plugin-packages.ts) 生成的包参考中的预稳定表述改为“未标记的 API 为 unstable”。不改代码。
2. 基线报告：生成并提交第一份 API 报告；CI 只检查报告是否最新。
3. 试点：晋升 `dsh-agent` 声明的 agent seam 成员：`ctx.agents`、`AgentHandle`、`Agent`、除已弃用的 `agent/request` 之外的 `agent/*` 事件，以及 `agent/pre-step` waterfall。它们引用的 session、scope 和 llm 包类型按上文加入承诺。Service Provider `dsh-agent-loop` 及其配置保持 unstable，因此试点不稳定任何配置。lint 工具和 `requires` 检查在这一阶段交付；同时更新 [package-manifest README](../../../../packages/util/package-manifest/README.zh.md) 和公开包 manifest 决策记录，说明已强制执行的检查。
4. 由各 seam 的维护者按需晋升更多成员和 seam；在文档站发布稳定 API 列表。
5. 满足上述条件时，为特定 seam 增加兼容适配插件。

### 待决问题

- `dsh.apis` 和 `dsh.requires` 成员的名称。
- DSH 1.0 之前按时间计算的弃用期长度。
- Python SDK 方法、SDK JSON-RPC 协议和 `cordis.yml` 配置字段是否纳入同一套级别，以及协议是否需要独立版本。
- 报告生成方式：API Extractor，还是基于 [scripts/verify-export-jsdoc.ts](../../../../scripts/verify-export-jsdoc.ts) 的导出遍历和 [scripts/jsdoc.ts](../../../../scripts/jsdoc.ts) 的标签解析生成的转储。
- lint 工具形式：基于同一导出遍历的独立发布检查器、非类型感知的近似实现，或上游 oxlint 规则。

## Alternatives considered

**不带版本的 `@stable` 标记。** 成本最低且可渐进，但插件无法说明自己基于哪个稳定 API 构建，Host 也无法检查，报告也无法区分新增成员和已有成员。保留为输入格式，并附上加入该成员的 seam 版本；列表由生成的报告提供。

**每次发布手工维护带版本的列表。** 插件作者有明确的参考，但为一千多个导出子路径和一百多个服务手工维护不现实，而且整个列表只有一个版本，任何 seam 的破坏性变更都会波及所有插件。保留为生成的报告，而不是手工维护的产物。

**整个平台一个 API 版本**（Android API level、VS Code `engines`）。对插件作者最简单，但 DSH 发布频繁，各 seam 独立演进；单一版本号要么随每次破坏性变更增长，要么抑制必要的破坏性变更。

**每个 npm 包独立 semver，取消锁步版本。** [npm 发布序列](../../implemented/process/2026-08-10-npm-release-sequences.zh.md)决策让所有 DSH 包使用同一版本，以保持发布和 peer 范围一致。包版本还会因不涉及任何插件所用 API 的内部重构而变化。seam 版本描述 API 兼容性，不改变包的发布方式。

**按包目录而不是 seam 分组。** `fs/` 等分组混合了独立演进的 Service Definition、provider 和工具。seam 本来就是架构使用的单位，维护成本最低。

**用子路径导出隔离 unstable API。** 让导入路径本身成为 opt-in，比 lint 告警更明确，但需要重组每个包的导出，并一次性破坏所有现有消费方，与渐进推进相矛盾。

**一开始就提供兼容层。** 每保留一个旧版本，都需要单独的转换代码和测试。在任何 seam 稳定、且外部插件依赖旧主版本之前，这项成本没有收益。

**按发布次数计算弃用期。** DSH 发布频率不固定，按次数计算给插件作者的时间不可预测。从首次记录弃用的发布开始按时间计算，结果可预测，并且可以从归档的报告中算出。

## Acceptance criteria

- 根目录 `AGENTS.md` 和落地步骤 1 列出的包文档写明未标记的 API 为 unstable，且弃用期已确定。
- 已提交的 API 报告覆盖导出、服务和事件；报告过期时 CI 失败。
- agent seam 的试点成员带有 `@stable agent@1.0.0`；CI 拒绝对它们或它们引用的类型的不兼容修改，并在涉及它们的 PR 中发布 stable API 变更摘要。
- lint 工具报告插件对 unstable 成员的使用，包括传给 `ctx.on()` 的 unstable 事件名。
- 声明了 `requires` 的插件在安装、更新和市场发现中按 seam 范围被接受或拒绝；未声明的插件行为与现在相同。

## Risks

- 其他 seam 中被引用的类型会加入引用方 seam 的承诺；晋升 agent seam 因而会在 session、scope 和 llm 等 seam 晋升之前冻结其部分类型。
- 行为变化依赖作者声明，评审可能遗漏。
- seam 版本与锁步包版本是两套编号，插件作者可能混淆。
- 晋升 agent seam 会约束仍在频繁变化的 loop 核心部分；晋升以这部分灵活性换取插件稳定性。
- lint 工具是新的发布工具，项目需要与 oxlint 配置一起维护。
- manifest 声明无法阻止插件使用未声明的 API；它只为检查和用户提供信息，不是强制手段。
