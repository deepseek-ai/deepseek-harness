# Agent Note: 稳定 API 规范

Status: proposed

[English](2026-11-05-stable-api-policy.md) | 中文

## Problem

DSH 的所有公开 API 都是 pre-stable：根目录 `AGENTS.md` 要求 API 变化时同步更新每个消费方。这条规则在仓库内部可行，但外部插件现在从 npm 和插件市场安装，作者无法判断哪些 API 可以依赖。所有发布的包共用一个锁步版本，包版本无法说明哪个 API 变了。唯一的兼容检查是 [plugin-compatibility.ts](../../../../packages/boot/app-boot/src/plugin-compatibility.ts) 中的 `evaluatePluginCompatibility`，它把插件的 `engines.dsh` 或 `@deepseek-ai/dsh-*` peer 范围与整个运行时版本比较。

目前源码中没有任何稳定性标记。包导出不带 `@public`、`@beta`、`@stable` 或 `@since` 标签，`@deprecated` 也只出现约十几次。唯一严格的兼容规则针对数据格式（[Session 格式状态](../../../../docs/session-format-status.zh.md)、SQLite schema 版本、持久化类型变更确认）和 [upgrade guide](../../../skills/dsh-create-upgrade-guide/SKILL.md)。

规范必须从这一现状起步。贡献者不需要先给所有 API 定级，规范才能生效；没有人标记的代码保持现有工作方式。

## Proposal

源码中的稳定性标记是唯一输入。生成的 API 报告把标记转换为每次发布的带版本稳定 API 列表。版本单位是[能力 seam](../../../../docs/glossary.zh.md#capability-seam)。未标记的内容一律保持 unstable，因此可以逐个 seam 推进。

### 稳定级别

| 级别 | 含义 | 变更规则 |
|---|---|---|
| internal | 标记为 `@internal`；仅在本仓库内部使用，不进入发布的 API 报告 | 随时修改并更新每个消费方 |
| unstable（默认） | 所有未带 stable 标记的公开导出、服务、事件和配置字段 | 随时修改，更新每个消费方，外部可感知的破坏性变更写入 upgrade guide |
| stable | 显式晋升，属于某个带版本的 seam API | 只允许向后兼容的新增；删除或不兼容修改需要先弃用，并升级 seam 主版本 |
| deprecated | 计划删除的 stable API | 自带日期的 `@deprecated` 标记起满弃用期后才能删除；须指明替代 API，或说明没有替代 |

[`packages/experimental/`](../../../../packages/experimental/README.zh.md#status) 下的包不能包含 stable API；包须先移出 experimental 分组，其中的 API 才能晋升。

### 单位：一个能力 seam

每个能力 seam 有自己的 API 版本，与锁步的包版本无关。一个 seam 的 API 包括它的 Service Definition、Service Definition 所在包声明的类型和事件、waterfall 调用约定，以及 Service Definition 所在包的配置字段。Service Provider 的配置字段跟随其所在 provider 包的级别。不属于任何 seam 的导出（如工具函数、CLI 选项、SDK wire 协议）保持 unstable，留待后续提案归属。

声明 Service Definition 的包在 manifest 中登记 seam。一个包可以声明多个 seam，因此该字段是列表：

```json
{ "dsh": { "apis": [{ "name": "agent", "version": "1.0.0", "stability": "stable" }] } }
```

字段名称和位置尚未确定。JSDoc 标签可以覆盖单个成员的 seam 级别：`@unstable` 让 stable seam 中的某个成员保持 unstable，`@deprecated YYYY-MM-DD <替代项或“无替代”>` 开始弃用期。`Context`、`SessionEventMap` 等声明合并接口的成员逐个标记。

### stable 覆盖的范围

stable 覆盖类型签名、事件顺序和 waterfall 调用约定（包括 listener 是否必须调用 `next()`），不覆盖默认配置值。CI 根据生成的报告检测签名变化。行为变化无法可靠地自动检测，由作者在 PR 中声明，做法与[持久化类型变更确认](../../../../docs/cookbook/reviewing-persistence-type-changes.zh.md)相同。这样可以避免把没有破坏调用方的变化报告为破坏性变更。

### API 报告与 CI

一个脚本生成并提交一份 API 报告，覆盖导出、Cordis 服务和事件，每个条目带有所属 seam、级别和版本。已推迟的 [API extractor 报告](2026-06-11-api-extractor-reports.zh.md)提案即这份报告的第一阶段。CI 把 stable 条目与上一份报告比较，以下情况失败：

- stable 条目被删除或不兼容修改，但没有升级 seam 主版本并写 upgrade guide；
- 被删除的条目没有事先弃用，或弃用期未满；
- 新增 stable 条目，但没有升级 seam 次版本；
- stable 签名引用了 unstable 类型。

unstable 条目的变化只出现在报告 diff 中，不会让 CI 失败。CI 还会在 PR 中发布 stable API 变更摘要。晋升和破坏性变更在正常 PR 评审中批准，不指定专门的 API owner 或委员会。

### 插件作者告警

一条类型感知的 lint 规则报告对 unstable API 的使用，工作方式与 [.oxlintrc.json](../../../../.oxlintrc.json) 已启用的 `typescript/no-deprecated` 相同：解析被调用的符号并读取其级别。插件作者在自己的构建中运行该规则；仓库对 stable 的 Service Definition 包运行该规则。子路径导出隔离（`…/unstable` 入口）已否决，见 [Alternatives considered](#alternatives-considered)。

### 插件依赖声明

插件可以声明所需的 seam 版本，例如 `"dsh": { "requires": { "agent": "^1.0.0" } }`；字段名称随 `apis` 的决定确定。声明该字段时，`evaluatePluginCompatibility` 把列出的每个 seam 范围与已安装的 seam 版本比较。按约定，插件还列出它使用的 unstable seam；Host 无法验证这份列表，插件管理页把它显示为风险。未声明时，现有的 `engines.dsh` 和 peer 范围检查保持不变，插件被视为依赖 unstable API。该声明不限制插件能导入或访问什么：Cordis 插件在 Host 进程内运行，可以导入任意包或访问 `ctx` 上的任意服务。

### 兼容层

为旧插件提供旧的 seam 主版本暂缓实现。当某个 stable seam 升级主版本、而外部插件仍依赖上一个主版本时，兼容层才有价值。届时 Host 只保留一份当前实现，由适配插件在其上提供旧的 Service Definition，并设定固定支持期限。

### 落地步骤

1. 仅规范：合入本 Agent Note，把根目录 `AGENTS.md` 的 pre-stable 规则改为“未标记的 API 为 unstable”，并确定弃用期。不改代码。
2. 基线报告：生成并提交第一份 API 报告；CI 只检查报告是否最新。
3. 试点：晋升 agent seam。其 stable API 是 `dsh-agent` 中的 Service Definition：`ctx.agents`、`Agent` 句柄、`agent/*` 事件和 `agent/pre-step` waterfall。Service Provider `dsh-agent-loop` 保持 unstable。已弃用的 `agent/request` waterfall 补上带日期的标记，并注明其他单次请求控制项没有替代，用来演练弃用和删除检查。lint 规则和 `requires` 检查在这一阶段交付。
4. 由各 seam 的维护者按需晋升更多 seam；在文档站发布稳定 API 列表。
5. 满足上述条件时，为特定 seam 增加兼容适配插件。

### 待决问题

- manifest 字段 `dsh.apis` 和 `dsh.requires` 的名称与位置。
- DSH 1.0 之前按时间计算的弃用期长度。
- Python SDK 方法、SDK JSON-RPC 协议和 `cordis.yml` 配置字段是否纳入同一套级别，以及协议是否需要独立版本。
- 报告生成方式：API Extractor，还是基于 [scripts/verify-export-jsdoc.ts](../../../../scripts/verify-export-jsdoc.ts) 的导出遍历和 [scripts/jsdoc.ts](../../../../scripts/jsdoc.ts) 的标签解析生成的转储。

## Alternatives considered

**不带版本的 `@stable` 标记。** 成本最低且可渐进，但插件无法说明自己基于哪个稳定 API 构建，Host 也无法检查，弃用期没有计量单位。保留为输入格式，版本由生成的报告提供。

**每次发布手工维护带版本的列表。** 插件作者有明确的参考，但为一千多个导出子路径和一百多个服务手工维护不现实，而且整个列表只有一个版本，任何 seam 的破坏性变更都会波及所有插件。保留为生成的报告，而不是手工维护的产物。

**整个平台一个 API 版本**（Android API level、VS Code `engines`）。对插件作者最简单，但 DSH 发布频繁，各 seam 独立演进；单一版本号要么随每次破坏性变更增长，要么抑制必要的破坏性变更。

**按包目录而不是 seam 分组。** `fs/` 等分组混合了独立演进的 Service Definition、provider 和工具。seam 本来就是架构使用的单位，维护成本最低。

**用子路径导出隔离 unstable API。** 让导入路径本身成为 opt-in，比 lint 告警更明确地要求 opt-in，但需要重组每个包的导出，并一次性破坏所有现有消费方，与渐进推进相矛盾。

**一开始就提供兼容层。** 每保留一个旧版本，都需要单独的转换代码和测试。在任何 seam 稳定、且外部插件依赖旧主版本之前，这项成本没有收益。

**按发布次数计算弃用期。** DSH 发布频率不固定，按次数计算给插件作者的时间不可预测。带日期的标记让 CI 可以机械地计算弃用期。

## Acceptance criteria

- 根目录 `AGENTS.md` 写明未标记的 API 为 unstable，且弃用期已确定。
- 已提交的 API 报告覆盖导出、服务和事件；报告过期时 CI 失败。
- agent seam 以 1.0.0 版本声明为 stable；CI 拒绝其中不兼容的签名变化或提前删除已弃用成员，并在涉及它的 PR 中发布 stable API 变更摘要。
- lint 规则报告插件对 unstable 成员的使用。
- 声明了 `requires` 的插件按 seam 范围被接受或拒绝；未声明的插件行为与现在相同。

## Risks

- 共享类型属于哪个 seam 并不总是明确；被两个 seam 使用的类型须在任一 seam 晋升前确定唯一归属。
- 行为变化依赖作者声明，评审可能遗漏。
- seam 版本与锁步包版本是两套编号，插件作者可能混淆。
- 晋升 agent seam 会约束仍在频繁变化的 loop 核心部分；晋升以这部分灵活性换取插件稳定性。
- manifest 声明无法阻止插件使用未声明的 API；它只为检查和用户提供信息，不是强制手段。
