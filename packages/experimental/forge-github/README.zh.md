---
description: "通过宿主上的 GitHub CLI 为实验性 forge 注册表服务 GitHub 主机。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-github

[English](README.md) | 中文

## 概述

借助宿主上已登录的 GitHub CLI，为 `ctx.forge` 读取 GitHub 与 GitHub Enterprise 的 pull request。每次轮询按主机批量查询，读取所有到期 pull request 的状态、改动行数、检查、评审结论、可合并性与未解决的评审讨论。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 forge 注册表之后挂载提供方，并显式列出每个 GitHub Enterprise 主机。

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
  config:
    hosts: [github.com, ghe.example.com]
```

即使 Session 在其他执行环境中运行命令，提供方也以宿主进程的形式运行 `gh`。每个主机执行一次 `gh auth login --hostname <host>` 完成登录。子进程继承的宿主环境去掉了 `DSH_*` 变量以及名称包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的变量，因此 `GH_TOKEN` 与 `GITHUB_TOKEN` 不会被转发，`gh` 使用自己的凭据存储。交互提示、更新提醒、分页器与颜色输出均被关闭。`maxOutputBytes` 必须是正安全整数；只有 `timeoutMs` 受运行时定时器上限约束。`ghCommand`、`hosts`、`timeoutMs` 与 `maxOutputBytes` 见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-forge-github)。

当主机在配置中时，提供方服务 `https`、`http`、`ssh`、`git` 形式的远端 URL，以及 `git@github.com:owner/name.git` 这类 scp 形式。HTTP(S) 远端在主机标识中保留自定义端口；SSH 和 Git 传输端口不计入主机标识。它服务 `https://<host>/<owner>/<name>/pull/<number>` 形式的 pull request URL，允许其后附带任意路径、查询或片段，并以去掉这些后缀的形式作为规范 URL。就绪探测运行 `gh auth status --hostname <host>`：退出码为 0 时为 `ready`，其他退出码为 `unauthenticated` 并带第一行诊断，`gh` 无法启动时为 `unavailable`。按 head 分支查找时，最多返回 20 个以该分支为 head 的打开状态 pull request，按创建时间从新到旧排列，不包含来自 fork 的 pull request；查找默认分支时返回空结果。

轮询只返回 head 提交的前 100 条检查上下文，不追读后续页。预览不完整时设置 `checksTruncated` 并保留 GitHub 的汇总状态，局部计数不代表完整列表。`fetchChecks(ref, signal)` 仅按需读取指定 PR 的完整详情，后续页固定使用首次响应的 rollup。所有 JSON 响应的 UTF-8 字节总量受 `maxOutputBytes` 限制，超出时返回 `too-large`。分页失败或游标不前进只使此次详情读取失败，保留轮询结果。同一应用、工作流、触发事件与检查名称的运行只保留运行 id 最新的一条；新的排队运行会替代旧的已完成运行。缺少数字数据库 id 的运行无法确定先后，因此按节点 id 保留。提交状态上下文按名称保留最新结果。完整列表从这些结果计算总体指示；未知上下文类型保留 GitHub 的汇总状态。

未完成的检查运行（check run），以及结论已过期、缺失或无法识别的已完成运行，均映射为 `pending`。其他已完成的检查映射为 `success`、`failure`（失败、超时、启动失败或需要操作）、`cancelled`、`skipped` 或 `neutral`。已取消的检查使汇总保持未通过状态。检查运行保留其开始与完成时间。提交状态上下文把 `SUCCESS` 映射为 `success`，把 `FAILURE` 与 `ERROR` 映射为 `failure`，其余状态均映射为 `pending`，且不带时间。GraphQL 的 `NOT_FOUND` 错误转为 `not-found` 失败。响应不含 GraphQL data 或 errors 时（包括 HTTP 错误 JSON），使用 stderr 的首条诊断或响应体的 message。认证诊断转为 `unauthenticated`；超出输出大小上限的检查分页转为 `too-large`；限流与其他失败转为 `unavailable`。head 查找在拒绝时保留相同诊断。

pull request 处于打开状态、不是草稿、GitHub 报告其合并状态为 `CLEAN`、`HAS_HOOKS` 或 `UNSTABLE`，且已登录用户具有 write、maintain 或 admin 权限时，`mergeReady` 为真。`mergeMethods` 列出仓库允许的压缩合并、合并提交与变基合并方式，用户默认的合并方式排在最前。标记为可评审运行 `gh pr ready <number> --repo <host>/<owner>/<name>`。合并经 `gh api` 调用 `PUT repos/<owner>/<name>/pulls/<number>/merge`，带上合并方式与预期的 head SHA，因此有新提交到达后 GitHub 会拒绝，报告为 `stale`。与 `gh pr merge` 不同，它从不启用自动合并、从不加入合并队列，也从不删除 head 分支。被拒绝的操作报告 GitHub 的原因，提到身份验证的诊断转为 `unauthenticated`。

`diff` 运行 `gh pr diff <number> --repo <host>/<owner>/<name> --color never`。`fileText` 经 `gh api` 以 raw 媒体类型读取 `repos/<owner>/<name>/contents/<path>?ref=<commit>`，只接受完整的 40 位或 64 位十六进制提交。`fileUrl` 返回 `https://<host>/<owner>/<name>/blob/<commit>/<path>`。两者的路径都逐段做百分号编码。被拒绝的读取在 HTTP 404 时为 `not-found`，诊断提到身份验证时为 `unauthenticated`，GitHub 报告 `too_large` 错误时（diff 超过其自身大小上限即会如此）为 `too-large`，其余为 `unavailable`，并带有 GitHub 的原因。输出超过 `maxOutputBytes` 的读取为 `too-large`，超过 `timeoutMs` 的为 `unavailable`。

提交评审时先检查 PR 当前的 head，再通过 REST API 发布单条行内评论或一次完整评审，并显式指定 `commit_id`。多行评论携带所属侧及包含端点的起止行号。评审结论为“评论”“批准”或“请求更改”。JSON 请求正文通过标准输入传递。provider 不会重试写操作；发送后的超时、异常响应或服务端错误会返回结果不明，由调用方到 GitHub 核对。检查与写入之间到来的新提交可能让已明确定位到旧提交的评审过时；GitHub 的这些接口不提供原子的 head 前置条件。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

一次读取按主机对引用分组，每个主机先发送一个 `gh api graphql` 查询。后续分页使用原汇总节点 id，因此 PR 的 head 变化不会让同一检查列表混入其他提交。查询内联经过校验的 owner、name 与编号，并为每个 pull request 设置别名，因此局部 GraphQL 错误只影响对应的别名。出现局部错误时 `gh` 以非零状态退出，但仍会输出完整响应；提供方先解析该响应，再检查退出码。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验与提供方注册 |
| [`src/provider.ts`](src/provider.ts) | URL 映射、按主机分组与失败分类 |
| [`src/graphql.ts`](src/graphql.ts) | 构造查询，并校验和映射响应 |
| [`src/gh.ts`](src/gh.ts) | 在宿主上执行 `gh`，清理环境变量并施加限制 |
| [`src/urls.ts`](src/urls.ts) | 解析远端 URL 与 pull request URL |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Forge 注册表](../forge/README.zh.md)——提供方注册与共享轮询。
- [Forge 子系统](../../../docs/subsystems/forge.zh.md)——提供方契约与变更请求类型。
- [子进程环境](../../subprocess/subprocess/README.zh.md)——共享的环境变量清理规则。

-----

<a id="model-experience"></a>
## 模型体验

无：提供方为宿主侧监听方读取 pull request 状态，不贡献模型上下文。

#### KV Cache 影响

无。提供方的输出只到达宿主侧监听方。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **宿主需要 GitHub CLI**——必须安装 `gh` 并为每个已配置主机登录；环境变量中的令牌不会被转发。不在 `hosts` 中的主机永远不会被读取，包括配置变更后保留的引用。状态读取为这些引用返回 `unavailable`；head 查找会在启动 `gh` 前拒绝。
- **前 100 个评审讨论**——前 100 个之后的未解决讨论不计入。
- **不发现 fork**——按 head 分支查找时，不包含 head 位于其他仓库的 pull request。
- **速率限制**——每次轮询以已登录账号的速率配额为每个主机消耗一次 GraphQL 查询；检查记录每多一页（100 条），再消耗一次查询。
- **不支持合并队列**——要求合并队列的基准分支会拒绝直接合并，提供方也不会把变更请求加入队列。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
