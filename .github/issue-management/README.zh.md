---
description: "面向仓库维护者的 Issue 策略强制范围、Project 访问与生命周期事件参考。"
---

# Issue 管理

[English](README.md) | 中文

## 摘要

贡献者可以引用 Issue 作为背景，而无需让 PR（Pull Request）校验依赖 Project 可用性。解决型引用还会强制检查 Project Priority。必需的 `Issue policy` job 与独立的生命周期工作流使用受信任的默认分支代码。

## 目录

- [PR 策略](#pull-request-policy)
- [生命周期事件](#lifecycle-events)
- [配置与限制](#configuration-and-limitations)
- [模块归属](#module-ownership)
- [验证](#verification)
- [开发备注](#dev-note)

-----

<a id="pull-request-policy"></a>
## PR 策略

[Issue policy](../workflows/issue-policy.yml)适用于已请求评审或已有评审、非草稿且由人类创建的 PR。豁免 PR 成功结束，不解析 Issue 引用、不签发 Project App token，也不查询 ProjectV2。工作流在昂贵读取前根据仓库实时状态判断强制范围；订阅事件仍保留必需 job。最终校验重新读取实时状态：预检不是缓存结论，也不是元数据编辑的豁免。

选择性预检要求受信任的检出中存在 [selective-preflight.json](selective-preflight.json)。缺少该标记时，工作流保留旧版行为：人类 PR 获取 Project token 并执行完整旧版校验；Bot/App PR 跳过两者。受支持的预检执行失败时，job 失败而不回退。

强制范围内的 PR 至少需要一个同仓库 Issue 引用、恰好一个规范的 `kind/*`、至少一个 `area/*`，以及最多一个 `p0`–`p3` 标签。不支持的 kind、退役别名和 `source/*` 标签会使校验失败；[标签分类](../../.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.zh.md)定义其含义。

- 信息型引用（如 `Refs #3624`）提供背景。校验通过 REST 区分 Issue 与 PR 编号，不读取这些引用的 Project 字段。仅含信息型引用的 PR 可以使用自己的 Priority，无需匹配所引用的 Issue。
- 解决型引用使用关闭关键词，如 `Fixes #123`、`Closes #123` 或 `Resolves #123`。校验期间只有解析为实际 Issue 的解决型引用需要读取 Project。PR Priority 必须匹配被解决 Issue 中的最高 Priority；带 Priority 标签的解决型 PR 要求每个被解决 Issue 均有 Priority。若所有被解决 Issue 的 Priority 均为空，PR 可以省略 Priority。
- HTML 注释、代码围栏或行内代码中的引用不计入。跨仓库引用与指向 PR 的引用不能满足 Issue 引用要求。

REST 读取使用仓库 `GITHUB_TOKEN`。Project 校验使用独立的 App token，具有 Issues 和组织 Projects 读取权限。缺少所需 Project 访问权限或字段配置无效时，校验失败，而不是绕过解决型 Issue 的 Priority 检查。

-----

<a id="lifecycle-events"></a>
## 生命周期事件

[Issue lifecycle](../workflows/issue-lifecycle.yml)独立于 PR 校验强制范围修改 Project 数据。PR 打开、重新打开和正文编辑可将解决型 Issue 推进至 `In progress`；仅编辑标题不会。请求评审以 `In review` 为目标。请求修改的评审以 `In progress` 为目标，并遵守[人工状态归属与终态保护](../../.agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.zh.md)。

仅批准或仅评论的评审不分配生命周期 runner。PR 推送与标签变更，以及 Issue 指派变更，不触发生命周期工作。其他已订阅的 Issue 事件维护 Project 归属、状态及审计评论；精确订阅列表由工作流定义。

PR 打开时，工作流按配置时区中的 PR 创建日期，为每个被引用 Issue（包括信息型引用）初始化空的 Project `Start Date`。此生命周期操作可以添加 Project 归属，并需要 Project 写权限；信息型引用的读取豁免仅适用于 PR 校验。[规划字段归属](../../.agents/notes/implemented/process/2026-09-02-project-local-issue-planning-fields.zh.md)定义日期保留规则。

-----

<a id="configuration-and-limitations"></a>
## 配置与限制

[config.json](config.json)选择仓库、Project、字段名、状态、生命周期操作者和时区。策略读取 Project 自定义单选 `Priority` 字段，而非组织原生 Issue Priority 字段。维护者手动设置 Project Priority；指引编辑原生 Issue 字段的 skill 不会填充该值。Issue 审计先移除 PR 专用 kind 标签和已停用的标签别名，再校验其余元数据。不提供字段迁移或 Priority 同步。

生命周期处理由事件驱动，不是协调器。被省略的事件不会修复 Project 状态，并发 Project mutation 也没有原子比较并交换保护。选择性求值不重新设计必需检查的权威来源，也不保证已测得的 Actions 分钟节省。[选择性求值决策](../../.agents/notes/implemented/process/2026-09-07-selective-issue-policy-evaluation.zh.md)记录取舍。

-----

<a id="module-ownership"></a>
## 模块归属

维护者直接复用所属模块；[policy.mjs](policy.mjs)仅负责读取事件文件、分派命令并报告命令失败。

<details>
<summary>实现职责</summary>

[rules.mjs](rules.mjs)拥有纯校验、引用解析、状态决策和日期转换。[github.mjs](github.mjs)拥有凭据选择、REST/GraphQL 传输、Issue/Project 读取，以及 Project 归属与字段写入。

[pull-request.mjs](pull-request.mjs)组装只读 PR 快照，并执行策略预检和校验，包括其工作流输出。[lifecycle.mjs](lifecycle.mjs)复用 PR 引用读取器与共享规则，协调 Project mutation、Issue 标签修复和审计评论。快照读取器不修改 GitHub；共享传输也支持写入，因此导入该模块不会限制调用方权限。

</details>

-----

<a id="verification"></a>
## 验证

在仓库根目录运行聚焦的无密钥策略测试：

```sh
node --test .github/issue-management/policy.test.mjs
```

[工作流测试](../../scripts/ci-workflow.spec.ts)验证触发器与权限声明。本地测试不能证明 GitHub 实际事件交付、App 安装访问权限或实际 runner 成本；仓库维护者在 Actions 中验证这些内容。

-----

<a id="dev-note"></a>
## 开发备注

无。
