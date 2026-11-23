---
kind: upgrade-guide
description: "forgePanel.reviewLists 的仓库参数要带主机，ForgeReviewHost 新增必填的 signIn。"
---

# 评审页的列表按主机指明仓库，并给出主机的登录命令

[English](guide.md) | 中文

## 变更

`forgePanel.reviewLists` 这个 Remote 原先以 `{ owner, name } | null` 作为仓库参数，并在每个主机上读取该仓库。现在它接受 `ForgeReviewRepository | null`，多了必填的 `host`，只在该主机上读取这个仓库。`owner` 保存 GitLab 项目的整个命名空间，包括嵌套的群组。

`ForgeReviewHost` 是该 Remote 流出的每个 `ForgeReviewFrame` 中一个主机的条目，它新增必填的 `signIn: string | null`：最近一次读取因未登录而失败时，是让提供方的 CLI 登录该主机的命令；其他情况为 null。

受影响的是 `@deepseek-ai/dsh-experimental-client-ui-forge` 之外、带仓库参数调用 `forgePanel.reviewLists` 的代码，以及构造 `ForgeReviewHost` 的代码，例如评审页帧的测试数据。两个类型都来自该包。只读取帧的代码不受影响。

## 迁移

1. 在每个带仓库参数的 `forgePanel.reviewLists` 调用中加上 `host`：列出该仓库的提供方的主机名，例如 `github.com`，即帧中 `ForgeReviewHost.host` 给出的名称。要读取每个主机上的所有仓库时，仍传 `null`。
2. 在代码构造的每个 `ForgeReviewHost` 中加上 `signIn: null`；该值代表未登录的主机时，填登录命令。
3. 运行类型检查；每处调用和取值都带上新成员后即通过。
