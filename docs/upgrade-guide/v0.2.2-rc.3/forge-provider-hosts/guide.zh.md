---
kind: upgrade-guide
description: "ForgeProvider 必须列出所服务的主机并给出名称，ForgeReadiness 带有登录命令，ForgeReviewData 列出读者可提交的评审结论。"
---

# Forge 提供方声明主机、名称、登录方式与评审结论

[English](guide.md) | 中文

## 变更

`ForgeProvider` 新增三个必需成员：`hosts`，提供方服务的小写主机名；`label`，读者熟知的这些主机的产品名，例如 `GitHub`；`changeRequestNoun`，取值 `'pull-request'` 或 `'merge-request'`。提供方列出的主机（不区分大小写）已被另一个已注册的提供方列出时，`ctx.forge.register` 会抛出错误。`ctx.forge.describe(forge)` 返回 `ForgeDescription`，面板用它在文案中称呼代码托管平台。

`ForgeReadiness` 新增必需的 `signIn: { command } | null`。Forge 面板在登录提示中显示这条命令，不再自行为 `github` 家族拼出 `gh auth login`。

`ForgeReviewData` 新增必需的 `reviewEvents`，即托管平台允许当前用户在提交的评审中记录的结论。评审对话框只提供这些结论，取代它原先内置的规则：拉取请求的作者只能评论。

受影响的是第三方提供方，以及构造这些值的代码。所有类型都来自 `@deepseek-ai/dsh-experimental-forge`。GitHub 提供方按其 `hosts` 设置填写 `hosts`，`label` 为 `'GitHub'`，`changeRequestNoun` 为 `'pull-request'`，`gh` 未登录时给出 `signIn`，拉取请求的作者只得到 `['comment']`。

## 迁移

1. 为每个 `ForgeProvider` 添加 `hosts`、`label` 与 `changeRequestNoun`。列出提供方会映射其 remote 或变更请求 URL 的每个主机，并确认其他已加载的提供方没有列出其中任何一个。
2. 在每个 `readiness` 结果中返回 `signIn: null`，或带有登录 shell 命令的 `{ command }`。
3. 在 `readReview` 的结果中返回 `reviewEvents`：当前用户可以提交的结论；`viewerCanReview` 为 false 时返回 `[]`。
4. 运行类型检查，再启动加载你的提供方的 profile；类型检查通过且 `ctx.forge.register` 没有抛出错误即完成迁移。
