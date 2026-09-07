# Agent Note: 语义化 Issue template 与不检查展示形式的 policy

Status: implemented

[English](2026-09-03-semantic-issue-templates-and-policy.md) | 中文

## 问题

Issue 与拉取请求（Pull Request，PR）template 把信息收集问题与评审证据混在一起，并用 `details` 元素折叠全部内容。未使用的 frontmatter 以及独立的 Idea 和 Research template 增加了选择，却没有改变仓库规划这些工作的方式。

Issue policy 还把 Markdown 展示方式当成仓库 metadata。对 `details` 元素、50 单位可见正文、中文标题、标题 metadata 前缀和正文 `Owner:` 行的要求会产生失败，却不能指出缺少了哪项语义决策。

## 决策

Issue template 只覆盖 Bug、Feature 和 Task。Bug 收集摘要、复现方式、当前行为、预期行为和环境。Feature 收集动机和行为。Task 收集摘要和交付物。除非未来的决策为 Idea 与 Research 定义不同的生命周期行为，否则它们属于 Task。

Issue template frontmatter 只含 `name`、`about` 和 `type`。Markdown 标题定义信息层级，HTML 注释说明每个标题下应填写的内容。

PR template 包含 `Motivation`、在 `Changes` 中相邻排列的公共接口与行为变化占位说明，以及直接展示每项测试方法并在局部 `details` 元素中放置对应证明的 `Testing` 条目。

Issue policy 不检查 `details` 展示形式、可见正文长度、标题语言、标题前缀或正文 ownership 行。其他所有 policy 检查、警告、生命周期操作、workflow 触发条件和 PR 强制范围豁免均保持既有行为。这项决策不增加 metadata 自动修复、Issue 分类、数据迁移或 workflow 能力。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)固定 template 清单与标题、PR 测试结构，并验证仅展示形式不同的标题、正文和 assignee 状态可以通过。

## 考虑过的替代方案

**保留 Idea 和 Research template。** 它们的表单没有建立区别于 Task 的生命周期或 policy 行为，因此独立入口只会增加选择，而不能保留有意义的 Type 区别。

**把展示规则保留为警告。** 这些规则会让原本可执行的 Issue 失败，也不能确定需求工作、预期行为或交付物是否清晰。

**增加 metadata 自动修复或 Issue 分类。** 这些行为需要新的修改规则、权限、失败处理和运行证据。它们应作为独立决策，而不随 policy 简化一同引入。

## 后果

贡献者会看到更短的表单，其标题分别对应 Issue 信息收集和 PR 评审所需的信息。Policy 失败会继续聚焦现有的语义 metadata 检查。

Policy 不会改写旧标签、选择缺失的 Issue Type、同步 Priority 或迁移现有仓库数据。这些操作未来如需自动化，必须单独决策和评审。
