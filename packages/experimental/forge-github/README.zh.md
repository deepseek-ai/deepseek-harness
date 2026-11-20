---
description: "通过宿主上的 GitHub CLI 为实验性 forge 注册表服务 GitHub 主机。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-github

[English](README.md) | 中文

## 概述

借助宿主上已登录的 GitHub CLI，为 `ctx.forge` 读取 GitHub 与 GitHub Enterprise 的 pull request。每次快照轮询按主机批量查询，读取所有到期 pull request 的状态、改动行数、检查、评审结论、可合并性与未解决的评审讨论。简报轮询只读取标题、状态、草稿标记、可合并性、评审结论与检查汇总状态。

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

在 forge 注册表之后挂载提供方，并显式列出每个 GitHub Enterprise 主机。`hosts` 至少列出一个主机名，每个可带端口，并且可以在提供方运行期间修改：[forge 面板](../client-ui-forge/README.zh.md)在插件页上这一行的页面里绘制该列表，保存后的列表会替换已注册的提供方，无需重新挂载插件。列出 GitLab 提供方所服务主机的列表不会被注册：Loader 记录这次拒绝，之前的列表继续服务，直到重启；重启时后挂载的提供方加载失败。

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
  config:
    hosts: [github.com, ghe.example.com]
```

即使 Session 在其他执行环境中运行命令，提供方也以宿主进程的形式运行 `gh`。每个主机执行一次 `gh auth login --hostname <host>` 完成登录。子进程继承的宿主环境去掉了 `DSH_*` 变量以及名称包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的变量，因此 `GH_TOKEN` 与 `GITHUB_TOKEN` 不会被转发，`gh` 使用自己的凭据存储。交互提示、更新提醒、分页器与颜色输出均被关闭。`maxOutputBytes`、`maxReviewThreads`、`snapshotBatchSize`、`briefBatchSize`、`maxCommits`、`maxViewedFiles` 与 `maxViewerItems` 必须是正安全整数，`maxViewerItems` 最大为 100；只有 `timeoutMs` 受运行时定时器上限约束。`ghCommand`、`hosts`、`timeoutMs`、`maxOutputBytes`、`maxReviewThreads`、`snapshotBatchSize`、`briefBatchSize`、`maxCommits`、`maxViewedFiles` 与 `maxViewerItems` 见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-forge-github)。

[forge-session](../forge-session/README.zh.md) 运行期间，插件向其注册 `gh` 命令规则。`gh pr create` 与 `gh pr new` 绑定它们打印的 pull request。`gh pr view`、`gh pr edit` 与 `gh pr checkout` 绑定 URL 选中的 pull request，或前后带有 `--repo`、`--repo=` 或 `-R` 的编号所选中的 pull request；包含主机的仓库参数或字面量 `GH_HOST` 赋值可直接确定 URL，其他仓库参数则在调用所在的 shell 中通过 `gh pr view <number> --repo <repository> --json url --jq .url` 解析。`gh api` 绑定其 REST 路径指向的 pull request，例如 `repos/octo/demo/pulls/7/files`：`--hostname` 或字面量 `GH_HOST` 赋值写明主机时直接绑定，否则通过同样的 `gh pr view` 查询解析，`{owner}/{repo}` 占位符则不带 `--repo`。

当主机在配置中时，提供方服务 `https`、`http`、`ssh`、`git` 形式的远端 URL，以及 `git@github.com:owner/name.git` 这类 scp 形式。HTTP(S) 远端在主机标识中保留自定义端口；SSH 和 Git 传输端口不计入主机标识。它服务 `https://<host>/<owner>/<name>/pull/<number>` 形式的 pull request URL，允许其后附带任意路径、查询或片段，并以去掉这些后缀的形式作为规范 URL。提供方以小写形式在 `hosts` 中列出配置的主机，自称 `GitHub`，并把变更请求称为拉取请求。就绪探测运行 `gh auth status --hostname <host>`：退出码为 0 时为 `ready`，其他退出码为 `unauthenticated`，带第一行诊断，并以 `gh auth login --hostname <host>` 作为登录命令，`gh` 无法启动时为 `unavailable`。按 head 分支查找时，最多返回 20 个以该分支为 head 的打开状态 pull request，按创建时间从新到旧排列，不包含来自 fork 的 pull request；查找默认分支时返回空结果。

轮询只返回 head 提交的前 100 条检查上下文，不追读后续页。预览不完整时设置 `checksTruncated` 并保留 GitHub 的汇总状态，局部计数不代表完整列表。`fetchChecks(ref, signal)` 仅按需读取指定 PR 的完整详情，后续页固定使用首次响应的 rollup。所有 JSON 响应（包括评审讨论分页）的 UTF-8 字节总量受 `maxOutputBytes` 限制，超出时返回 `too-large`。分页失败或游标不前进只使此次详情读取失败，保留轮询结果。同一应用、工作流、触发事件与检查名称的运行只保留运行 id 最新的一条；新的排队运行会替代旧的已完成运行。缺少数字数据库 id 的运行无法确定先后，因此按节点 id 保留。提交状态上下文按名称保留最新结果。完整列表从这些结果计算总体指示；未知上下文类型保留 GitHub 的汇总状态。

快照读取把同一主机最多 `snapshotBatchSize`（默认 8）个 pull request 放进一个 GraphQL 查询，`fetchBriefs` 则最多放 `briefBatchSize`（默认 25）个。提供方把这两个大小告知 forge 注册表，注册表每次调用轮询同一主机的这么多个 pull request，所以一次轮询的每个查询独占注册表的 `fetchTimeoutMs` 时限，查询得到应答后它的结果就会发布。一次读取指定了同一主机更多的 pull request 时，依次发送各个查询；快照查询读完自己的评审讨论分页后，才发送下一个查询。简报查询读取 `url`、`title`、`state`、`isDraft`、`mergeable`、`reviewDecision` 以及 head 提交的 `statusCheckRollup.state`，不读取检查列表、评审人、评审讨论和仓库的合并设置。简报的检查汇总结果就是这个 `statusCheckRollup.state`；检查列表完整的快照则根据自己保留的检查得出结果。某个查询的 `gh` 无法启动、超过 `timeoutMs` 或输出超过 `maxOutputBytes`，或被 GitHub 拒绝时，只有该查询内的 pull request 失败；响应中不带路径的 GraphQL 错误也只影响该查询内的 pull request。读取被取消后不再发送后续查询。

每次快照读取按每页最多 100 个统计评审讨论，直到已统计 `maxReviewThreads`（默认 1,000）个为止；第一页之后每读一页多一次 GraphQL 查询。讨论更多的 pull request 设置 `threadsTruncated`，其 `unresolvedThreads` 只统计已读取的讨论。讨论分页失败或游标不前进时，该 pull request 的状态读取失败，同批其他 pull request 不受影响；不发布不完整的计数。

未完成的检查运行（check run），以及结论已过期、缺失或无法识别的已完成运行，均映射为 `pending`。其他已完成的检查映射为 `success`、`failure`（失败、超时、启动失败或需要操作）、`cancelled`、`skipped` 或 `neutral`。已取消的检查使汇总保持未通过状态。检查运行保留其开始与完成时间。提交状态上下文把 `SUCCESS` 映射为 `success`，把 `FAILURE` 与 `ERROR` 映射为 `failure`，其余状态均映射为 `pending`，且不带时间。GraphQL 的 `NOT_FOUND` 错误转为 `not-found` 失败。响应不含 GraphQL data 或 errors 时（包括 HTTP 错误 JSON），使用 stderr 的首条诊断或响应体的 message。认证诊断转为 `unauthenticated`；超出输出大小上限的检查分页转为 `too-large`；GraphQL 的 `RATE_LIMITED` 错误或提到限流的诊断转为 `rate-limited`；其他失败转为 `unavailable`。head 查找在拒绝时保留相同诊断。

pull request 处于打开状态、不是草稿、GitHub 报告其合并状态为 `CLEAN`、`HAS_HOOKS` 或 `UNSTABLE`，且已登录用户具有 write、maintain 或 admin 权限时，`mergeReady` 为真。`mergeMethods` 列出仓库允许的压缩合并、合并提交与变基合并方式，用户默认的合并方式排在最前。标记为可评审运行 `gh pr ready <number> --repo <host>/<owner>/<name>`。合并经 `gh api` 调用 `PUT repos/<owner>/<name>/pulls/<number>/merge`，带上合并方式与预期的 head SHA，因此有新提交到达后 GitHub 会拒绝，报告为 `stale`。与 `gh pr merge` 不同，它从不启用自动合并、从不加入合并队列，也从不删除 head 分支。被拒绝的操作报告 GitHub 的原因，提到身份验证的诊断转为 `unauthenticated`。

每个快照都带有 `autoMerge`，取自快照查询的四个字段。pull request 有 `autoMergeRequest` 时 `enabled` 为 true，其 `mergeMethod` 与 `enabledBy` 的登录名给出 `method` 与 `enabledBy`；压缩合并、合并提交与变基合并之外的合并方式读作 null。`canDisable` 即 GitHub 的 `viewerCanDisableAutoMerge`，`canEnable` 即其 `viewerCanEnableAutoMerge`，但在带合并队列的基准分支上（`isMergeQueueEnabled`）`canEnable` 为 false。以 admin 权限读取本仓库 150 个 open pull request 时，全部 71 个草稿、全部 4 个已启用自动合并的，以及唯一一个合并状态为 `CLEAN` 的，`viewerCanEnableAutoMerge` 都为 false；其余 74 个中有 72 个为 true。`setAutoMerge` 先读取 pull request 的节点 id 与 head。启用时，head 不是 `request.headSha` 则不发送 mutation，直接返回 `stale`；否则以合并方式与 `expectedHeadOid` 调用 `enablePullRequestAutoMerge`，因此新提交到来后 GitHub 会拒绝；关闭时调用 `disablePullRequestAutoMerge`，与 head 无关。mutation 与 `writeReview` 使用同一个发送方式，且从不重试：拒绝为 `failed`，无法确认结果的答复为 `unknown`，都附 GitHub 的原因。GraphQL 的拒绝不带能说明 head 已移动的 HTTP 状态，因此启用被拒绝后会再读一次 head，此时 head 已是另一个提交则返回 `stale`。

`diff` 在一次 GraphQL 查询中读取 `headRefOid` 与 `baseRefOid`，head 不是请求的提交时返回 `stale`；请求的提交必须是完整的 40 位或 64 位十六进制提交。否则经 `gh api --allow-escape-sequences` 以 diff 媒体类型读取 `repos/<owner>/<name>/compare/<baseRefOid>...<headSha>`，即两个提交的合并基准到 head 的补丁，两端都不跟随移动的分支。每个状态快照把 `baseRefOid` 作为 `baseSha` 携带（GitHub 返回的不是完整提交时省略）；拿到它时，`diff` 在 GraphQL 查询确认 head 的同时就开始这次比较，head 已过时或基准提交不同时会取消提前开始的比较并等它结束，然后才返回。实测的所有 open 与已合并 pull request 上，该补丁与不接受提交参数的 `gh pr diff` 逐字节一致。与 pull request diff 不同，compare 接口会返回超过 300 个文件的 diff，因此这类 diff 只有在输出超过 `maxOutputBytes` 或 GitHub 自身拒绝时才为 `too-large`。`--allow-escape-sequences` 保留文件内容中的终端转义序列；否则 `gh` 2.97 及以上版本拒绝输出。更早的 `gh` 在发出请求前就以 `unknown flag` 拒绝该选项，且原样输出这类序列，因此遇到这一拒绝时去掉该选项重读一次。`fileText` 经 `gh api` 以 raw 媒体类型读取 `repos/<owner>/<name>/contents/<path>?ref=<commit>`，只接受完整的 40 位或 64 位十六进制提交。`fileUrl` 返回 `https://<host>/<owner>/<name>/blob/<commit>/<path>`。两者的路径都逐段做百分号编码。`commits` 经 GraphQL 读取拉取请求的提交，每页 100 个，owner、name、number 与游标作为变量传入，直到 `maxCommits`；每一页报告的 head 与提交总数必须与第一页相同，游标也不能与之前任何一页重复，否则返回 `unavailable`。`compare` 用与 `diff` 相同的 compare 请求读取两个完整提交的合并基准到第二个提交的补丁。`mergeBase` 从 `repos/<owner>/<name>/compare/<base>...<head>?page=2&per_page=1` 读取 `merge_base_commit.sha`；这一页比较结果不列文件。返回值不是完整提交时为 `unavailable`。被拒绝的读取在 HTTP 404 时为 `not-found`，诊断提到身份验证时为 `unauthenticated`，GitHub 以 HTTP 406 拒绝或报告 `too_large` 错误时（diff 或文件超过其大小上限即会如此）为 `too-large`，HTTP 429 或提到主限流、次级限流的消息为 `rate-limited`，其余为 `unavailable`，并带有 GitHub 的原因。输出超过 `maxOutputBytes` 的读取为 `too-large`，超过 `timeoutMs` 的为 `unavailable`。

提交评审时先检查 PR 当前的 head，再通过 REST API 发布单条行内评论或一次完整评审，并显式指定 `commit_id`。多行评论携带所属侧及包含端点的起止行号。用户有待提交评审时 GitHub 会拒绝单条评论，因此更改视图只在没有待提交评审时提供单条评论。评审结论为“评论”“批准”或“请求更改”。JSON 请求正文通过标准输入传递。provider 不会重试写操作；发送后的超时、异常响应或服务端错误会返回结果不明，由调用方到 GitHub 核对。检查与写入之间到来的新提交可能让已明确定位到旧提交的评审过时；GitHub 的这些接口不提供原子的 head 前置条件。

`readReview` 用一次 GraphQL 查询读取评审讨论，同时读出 `headRefOid` 和当前登录用户的登录名；head 不是所请求的提交时返回 `stale`。讨论按每页最多 100 个分页读取，直到读满 `maxReviewThreads` 个；第一页之后的每一页讨论都会再次读取 head，因此读取期间有新的推送时返回 `stale`。每个讨论的评论都会经评论分页全部读出，评论分页不读取 head；讨论第一条评论的提交和 `diffHunk` 只读一次。所有页面按 JSON 计合计不得超过 `maxOutputBytes`：之后的某一页会超出上限时，该页及其后的讨论被丢弃，结果标记为 `truncated`，与讨论数超过 `maxReviewThreads` 时相同；第一页的输出本身超过上限时，读取以 `too-large` 失败。行级讨论只有在 GitHub 报告它未过期、带有 `line`，且第一条评论的 `commit` 就是 head 时，才得到 `current` 位置：force-push 之后写在旧提交上的评论保留的 `line` 是那个旧提交的行号，GitHub 也可能在标记讨论过期的同时保留它的 `line`。`original` 取自第一条评论 `originalCommit` 上的 `originalLine` 和 `originalStartLine`；`subjectType: FILE` 的讨论两者都没有。起始行在 diff 另一侧的范围只保留最后一行。没有评论的讨论会被略去。GitHub 上不存在该 PR 或仓库时，读取返回 `not-found`，与读取提交列表时相同。REST 的 `position` 无法区分已过期的讨论，因此不读取。

同一第一页还会读出当前登录用户可以写入哪些内容：每个讨论的 `viewerCanReply`，以及按讨论当前状态读取的 `viewerCanResolve` 或 `viewerCanUnresolve`，每条评论的 `viewerCanUpdate` 和 `viewerCanDelete`。它也读出该用户的待提交评审，即该用户自己写的 `PENDING` 评审，连同它的评论数；GitHub 只向作者列出待提交评审，读取最多取 100 条，即使排在前面的是别人的评审，也能找到该用户自己的。除非仓库已归档，或对话已锁定且用户没有 `ADMIN`、`MAINTAIN` 或 `WRITE` 权限，用户都可以开始待提交评审。可以评审的用户能记录任何结论，但在 `viewerDidAuthor` 为 true 的拉取请求上，GitHub 只允许评论。

`writeReview` 先用一次 GraphQL 查询读出 pull request 的 `headRefOid` 和用户的待提交评审；head 不是 `write.headSha` 时不写入，直接返回 `stale`。随后发送一个 mutation，变量以 JSON 形式经 stdin 传入：回复用 `addPullRequestReviewThreadReply`，待提交的回复加入待提交评审；`resolveReviewThread` 或 `unresolveReviewThread`；`updatePullRequestReviewComment` 或 `deletePullRequestReviewComment`；新评论用 `addPullRequestReviewThread` 加入待提交评审，用户还没有待提交评审时，用 `addPullRequestReview` 在 `write.headSha` 上开始一个评审，并把这条评论作为它的第一个讨论；提交或丢弃用 `submitPullRequestReview` 或 `deletePullRequestReview`，作用于写操作指定的待提交评审，检查时必须仍能找到它。没有待提交评审时，待提交的回复会先在 head 上开始一个空评审，因此需要两个 mutation；回复随后失败时，这个空评审会保留下来。写入讨论或评论时，同一次检查还会读出它所属的 pull request，不是当前 pull request 时不发送 mutation，直接返回 `failed`。用户有待提交评审时，GitHub 会把该用户的每条回复都加入这个评审，即使发送时没有带上评审 id；因此该用户有待提交评审时，立即回复不发送 mutation，直接返回 `failed`。加入待提交评审的讨论使用当前 head 的行号，与评审开始时所在的提交无关。mutation 返回 payload 即表示 GitHub 已执行；错误类型全部表示拒绝（`FORBIDDEN`、`INSUFFICIENT_SCOPES`、`NOT_FOUND`、`RATE_LIMITED`、`UNPROCESSABLE`）的 GraphQL 错误以及 HTTP 400、401、403、404、409、422 拒绝返回 `failed`，`gh` 无法启动时也是如此；其他 GraphQL 错误（例如 GitHub 的超时提示）、`gh` 超时、服务端错误或没有 payload 的响应返回 `unknown`。mutation 从不重试。

每次状态读取还会读取每个 pull request 的概览：最多 25 个评审请求、最近评审、最近的表态评审与关闭的 issue 引用，GitHub 统计到更多时把对应列表标记为截断。评审请求指向用户、bot 或团队，并说明是否为代码所有者请求。作者本人的评审与没有作者的评审被略去；被驳回的评审记为 `dismissed`，较新的表态评审优先于评论决定结论。pull request 未处于 open、GitHub 报告存在冲突或当前登录用户无权更新其 head 时，`branchUpdates` 为空：head 已是最新、或用户无权更新时，GitHub 的 `viewerCanUpdateBranch` 都为 false。否则提供 merge，GitHub 的 `canBeRebased` 为 true 时也提供 rebase。`canBeRebased` 表示该 pull request 能否以 rebase 方式合并，因此跟随仓库的 rebase 合并设置，不允许 rebase 合并的仓库只提供 merge。`mergeStateStatus` 无法判断 head 是否落后于基线，因为 BLOCKED、DIRTY 与 UNSTABLE 优先于 BEHIND：本仓库 23 个 head 落后于基线的 open pull request 中，没有一个报告 BEHIND。`canRequestReviews` 要求 open 的 pull request 与 triage、write、maintain 或 admin 权限，`canRerunChecks` 要求 write、maintain 或 admin 权限。GitHub Actions 工作流的 check run 以其工作流运行作为 `rerun`；状态上下文与其他 check run 没有 `rerun`。

`viewedFiles` 经 GraphQL 每页 100 个列出 pull request 的文件，最多 `maxViewedFiles`（默认 3,000）个，GitHub 统计到更多时设置 `truncated`；GitHub 的 `VIEWED`、`UNVIEWED` 与 `DISMISSED` 分别映射为 `viewed`、`unviewed` 与 `dismissed`，未知状态映射为 `unviewed`。某页的 head 不是请求的提交时读取为 `stale`，分页不前进时为 `unavailable`。`setViewed` 先检查 head，再调用 `markFileAsViewed` 或 `unmarkFileAsViewed`；GitHub 对每个文件和用户只保存一个已审阅标记，与提交无关。`rerunChecks` 读取完整检查，head 已移动时返回 `stale`，再对每个含失败检查且没有进行中检查的工作流运行 POST 一次 `repos/<owner>/<name>/actions/runs/<run>/rerun-failed-jobs`，因为 GitHub 不提供运行中工作流的重跑；它会尝试每个这样的运行，汇总报告被拒绝的运行，只在缺少凭据时提前停止。GitHub 会重跑失败的 job 及依赖它们的 job。`requestReviews` 在一次 GraphQL 查询中把用户登录名与 `organization/slug` 形式的团队名解析为节点 id，再以 `union: true` 调用 `requestReviews`，保留已有请求；bot 登录名加上 `[bot]` 后缀后，随后交给 `requestReviewsByLogin`，GitHub Enterprise Server 3.19 与 3.20 没有该 mutation。`reviewerCandidates` 列出登录名或名称包含查询文本的最多 20 个可指派用户，查询为空时 GitHub 建议的评审者排在最前；作者被略去。`updateBranch` 先检查 head，再以更新方式与 `expectedHeadOid` 调用 `updatePullRequestBranch`，因此新提交到来后 GitHub 会拒绝。这些写操作与 `writeReview` 使用同一个发送方式，把 GraphQL 文档与变量作为 JSON 经标准输入发送，且从不重试：拒绝为 `failed`，无法确认结果的答复为 `unknown`，都附 GitHub 的原因。

`viewer` 在每个已配置主机上提供 `review-requested`、`authored` 与 `involved` 三个列表，每次读取最多 `maxViewerItems`（默认 50）个拉取请求。`listForViewer` 用一次 GraphQL `search` 读取一个列表：未归档仓库中打开的拉取请求，按最近更新在前；三个列表的限定词分别为 `review-requested:@me`（也匹配请求给用户所在团队的评审）、`author:@me` 与 `involves:@me -author:@me -review-requested:@me`，因此互不重叠；限定仓库时追加 `repo:<owner>/<name>`，owner 或仓库名不是合法片段时不发请求，直接返回 `not-found`。GitHub 对在一个文档里搜索多个列表的请求返回网关错误，所以每个列表单独请求。每项带有当前用户最近提交的评审、请求当前用户或其所在团队评审的那条请求，以及 head 提交的检查汇总；不是拉取请求的结果被忽略。`countForViewer` 在一次请求中读取每个列表的 `issueCount`。search 读的是搜索索引，所以拉取请求在变化后可能要过几分钟才进入或离开列表。`readDescription` 用一次 GraphQL 查询读取 `body`、`bodyHTML`、`createdAt` 与最多 100 个标签。私有仓库中，上传图片在 Markdown 里的地址 `https://<host>/user-attachments/assets/<uuid>` 只在带有用户 GitHub 会话时才返回图片，而 `bodyHTML` 为同一上传给出带签名的 `private-user-images` 地址，五分钟内无需会话即可加载；`images` 把每个 Markdown 地址映射到同一上传的签名地址，`imagesExpireAt` 为这些令牌中最早的 `exp`。读取 `bodyHTML` 只为得到这些地址。

`readActivity` 用一次 GraphQL 查询读取 pull request 时间线上最近的 100 条记录，即只含所映射条目类型的 `timelineItems(last: 100)`，并由 `pageInfo.hasPreviousPage` 得出 `truncated`。记录保持 GitHub 的顺序，即按时间从早到晚：提交取提交者日期，评审取 `submittedAt`，其余记录取 `createdAt`。`PullRequestCommit` 映射为 `commit`，标题取 `messageHeadline`（过长时 GitHub 会以省略号截短），actor 为提交作者的 GitHub 账号，作者没有账号时为空；`IssueComment` 映射为 `comment`；`PullRequestReview` 映射为 `review`，带有结论以及它在行和文件上留下的评论数，`PENDING` 评审被略去；`ReviewRequestedEvent` 映射为 `review-requested`，带有被请求账号的登录名或 `organization/slug` 形式的团队名；`RenamedTitleEvent` 映射为 `renamed`；`MergedEvent`、`ClosedEvent`、`ReopenedEvent`、`ReadyForReviewEvent`、`ConvertToDraftEvent`、`HeadRefForcePushedEvent`、`AutoMergeEnabledEvent` 与 `AutoMergeDisabledEvent` 映射为含义相同的类型。GitHub 每次合并都会同时记录一个 `ClosedEvent`，因此在已合并的 pull request 上，之后没有 `ReopenedEvent` 的 `ClosedEvent` 被略去。GitHub 把账号的类型标为 `Bot`，或账号的登录名以 `[bot]` 结尾（GitHub 对作为提交作者的应用如此拼写）时，该账号是 bot。GitHub 的 schema 没有说明当前登录用户能否在 pull request 上评论的字段，因此 `viewerCanComment` 沿用 `readReview` 的规则：仓库已归档，或对话已锁定且用户没有 `ADMIN`、`MAINTAIN` 或 `WRITE` 权限时为 false。`addComment` 经 `gh api` 向 `repos/<owner>/<name>/issues/<number>/comments` POST 一次，评论文本以 JSON 形式经 stdin 传入，且从不重试：提到认证的诊断信息返回 `unauthenticated`；HTTP 400、403、404、409 或 422 拒绝以及 `gh` 无法启动返回 `failed`；`gh` 超时、服务端错误、发送后被取消的请求以及没有已保存评论 `id` 的答复返回 `unknown`，都附 GitHub 的原因或诊断信息。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

快照读取与简报读取都按主机对引用分组，在第一次请求前为每 `snapshotBatchSize` 或 `briefBatchSize` 个引用构造一个 `gh api graphql` 查询，再依次发送。后续分页使用原汇总节点 id，因此 PR 的 head 变化不会让同一检查列表混入其他提交。查询内联经过校验的 owner、name 与编号，并为每个 pull request 设置别名，因此局部 GraphQL 错误只影响对应的别名。出现局部错误时 `gh` 以非零状态退出，但仍会输出完整响应；提供方先解析该响应，再检查退出码。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验，以及提供方与命令规则注册 |
| [`src/commands.ts`](src/commands.ts) | forge-session 据以绑定 pull request 的 `gh` 命令规则 |
| [`src/provider.ts`](src/provider.ts) | URL 映射、按主机分组与失败分类 |
| [`src/graphql.ts`](src/graphql.ts) | 构造查询，并校验和映射响应 |
| [`src/compare.ts`](src/compare.ts) | 经 compare API 读取两个提交之间的补丁，供所有 diff 读取共用 |
| [`src/threads.ts`](src/threads.ts) | 读取评审讨论、分页，并映射到 head 位置与原始位置 |
| [`src/review-writes.ts`](src/review-writes.ts) | head 检查，以及评审讨论与待提交评审的 mutation |
| [`src/mutation.ts`](src/mutation.ts) | 发送单个 GraphQL mutation 并判定其结果 |
| [`src/gh.ts`](src/gh.ts) | 在宿主上执行 `gh`，清理环境变量并施加限制 |
| [`src/viewed.ts`](src/viewed.ts) | 读取与写入已审阅文件 |
| [`src/overview.ts`](src/overview.ts) | 评审请求、评审者搜索、分支更新与自动合并 |
| [`src/activity.ts`](src/activity.ts) | 读取时间线，并映射为活动记录 |
| [`src/pull-request-node.ts`](src/pull-request-node.ts) | 在核对过的 head 上读取 pull request 节点 id，供写操作使用 |
| [`src/urls.ts`](src/urls.ts) | 解析远端 URL 与 pull request URL，并校验写入请求的名称与提交 |

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
- **评审讨论上限**——每次状态读取每个 pull request 最多统计、每次评审读取最多读取 `maxReviewThreads` 个评审讨论；超出时 `unresolvedThreads` 只是下限，由 `threadsTruncated` 标出，评审读取的结果标记为 `truncated`。
- **调用时限**——一个快照查询和它的 pull request 的续页，在 `ctx.forge` 的同一个 `fetchTimeoutMs` 时限内运行；评审讨论很多的 pull request 可能让它所在的查询超过该时限，这时该查询里最多 `snapshotBatchSize` 个 pull request 都报告 `unavailable`，而不只是讨论很多的那个。
- **简报的检查结果**——简报报告 GitHub 的检查汇总状态，检查列表完整的快照则自行得出结果；同一个 pull request 的两个结果不一致时，没有机制去对齐它们。
- **基准分支被改写**——diff 从 head 与 GitHub 在 pull request 最后一次更新时记录的基准提交的合并基准开始。基准分支被强制推送后，该合并基准可能不同于 GitHub pull request 页面使用的合并基准，因此在 pull request 更新前，补丁可能多出或缺少提交。
- **不发现 fork**——按 head 分支查找时，不包含 head 位于其他仓库的 pull request。
- **速率限制**——每次简报轮询为每个主机的每 `briefBatchSize` 个 pull request 消耗一次 GraphQL 查询；每次快照轮询为每个主机的每 `snapshotBatchSize` 个 pull request 消耗一次，评审讨论每多一页（100 个）再消耗一次；完整检查读取时检查记录每多一页（100 条）再消耗一次；每次 diff 读取消耗一次 GraphQL 查询与一次 REST 请求；最新状态之后基准提交有变化时再多一次 REST 请求。这些都计入已登录账号的速率配额。每次评审读取每页 100 个讨论消耗一次 GraphQL 查询，单个讨论的评论每多一页（100 条）再消耗一次。每次评审写入消耗一次用于检查 head 的 GraphQL 查询和一个 mutation；开始待提交评审的待提交回复需要两个 mutation。每次活动读取消耗一次 GraphQL 查询，每次添加评论消耗一次 REST 请求。每次设置自动合并消耗一次 GraphQL 查询和一个 mutation；启用被拒绝后再多一次查询。
- **不支持合并队列**——要求合并队列的基准分支会拒绝直接合并，`merge` 也不会把变更请求加入队列。在带合并队列的基准分支上 `autoMerge.canEnable` 为 false，因为 GitHub 在那里忽略自动合并请求的合并方式；`setAutoMerge` 本身不检查是否有合并队列，在 GitHub 上启用的自动合并仍会如实报告。
- **活动记录上限**——每次活动读取只列出所映射类型中最近的 100 条时间线记录，`truncated` 标出还有更早记录的 pull request，更早的记录无法读取。标签变更、指派、来自其他 issue 与 pull request 的引用，以及其他各类时间线记录都不列出。读取只有一次请求，因此这些记录的输出合计超过 `maxOutputBytes` 时，读取以 `too-large` 失败。
- **评论权限**——GitHub 没有说明当前登录用户能否评论的字段，因此对被仓库所有者屏蔽、或被互动限制排除的用户，`viewerCanComment` 仍为 true；GitHub 只在评论发出时才拒绝该用户的评论。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
