---
description: "通过宿主上的 GitLab CLI 为实验性 forge 注册表服务 GitLab 主机。"
kind: "package-reference"
---

# @deepseek-ai/dsh-forge-gitlab

[English](README.md) | 中文

## 概述

借助宿主上已经登录的 GitLab CLI，为 `ctx.forge` 读写 GitLab.com 与自建 GitLab 的合并请求。每次轮询读取每个到期合并请求的状态、变更行数、head 流水线的作业、评审者与批准、可合并性、未解决的讨论和关闭的 issue；变更视图读取钉在 head 上的 diff、提交，以及评审讨论在 head 上和最后出现处的位置。它以讨论和草稿笔记（draft notes）写入评论，解决讨论，提交和批准评审，把草稿标记为可评审，合并，重试流水线，请求评审，并做变基。

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

在 forge 注册表之后挂载提供方，并显式列出每个自建主机。Forge 插件包以 `gitlab.com` 挂载它。

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-forge-gitlab'
  config:
    hosts: [gitlab.com, gitlab.example.com]
```

即使 Session 在其他执行环境中运行命令，提供方也以宿主进程的形式运行 `glab`。每个主机执行一次 `glab auth login --hostname <host>` 完成登录。子进程继承的宿主环境去掉了 `DSH_*` 变量、名称包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 的变量，以及让 `glab` 改选其他主机、仓库或远端的变量，例如 `GITLAB_HOST`、`GITLAB_REPO` 和 `GLAB_REMOTE_ALIAS`；它在临时目录中运行，因为在检出目录里 `glab` 会按该检出的远端解析项目路径。提示、更新检查、遥测、分页器和颜色都已关闭，每个请求都用 `--hostname` 指明主机。数值上限必须是正的安全整数；只有 `timeoutMs` 受运行时定时器上限约束。`glabCommand`、`hosts`、`timeoutMs`、`maxOutputBytes`、`maxReviewThreads`、`maxCommits`、`statusBatchSize`、`maxConcurrentRequests` 和 `maxCachedVersionBytes` 列在[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-forge-gitlab)中。

提供方以小写形式在 `hosts` 中列出配置的主机，自称 `GitLab`，并把变更请求称为合并请求。当主机在配置中时，它服务 `https`、`http`、`ssh`、`git` 形式的远端 URL，以及 `git@gitlab.com:group/sub/app.git` 这类 scp 形式；嵌套群组组成仓库的 owner，例如 `group/sub`。HTTP(S) 远端在主机标识中保留自定义端口；SSH 和 Git 传输端口不计入主机标识。它服务 `https://<host>/<namespace>/<project>/-/merge_requests/<number>` 形式的合并请求 URL，允许其后附带任意路径、查询或片段，并以去掉这些后缀的形式作为规范 URL；`fileUrl` 返回 `https://<host>/<namespace>/<project>/-/blob/<commit>/<path>`。就绪探测读取 REST 的 `user` 资源：成功时为 `ready`；凭据被拒绝时为 `unauthenticated`，并以 `glab auth login --hostname <host>` 作为登录命令；其他失败（包括 `glab` 无法启动）为 `unavailable`。按 head 分支查找时，最多返回 20 个源分支为该分支、且源项目就是目标项目的打开状态合并请求，按创建时间从新到旧排列；查找项目默认分支时返回空结果。

[forge-session](../forge-session/README.zh.md) 运行期间，插件向其注册 `glab` 命令规则。`glab mr create` 与 `glab mr new` 绑定它们打印的 merge request。`glab mr view`、`glab mr update` 与 `glab mr checkout` 绑定 URL 选中的 merge request，或前后带有 `--repo`、`--repo=` 或 `-R` 的编号所选中的 merge request；完整的 `http` 或 `https` 项目 URL 可直接确定 URL，其他仓库形式（如 `group/app` 或 Git URL）则在调用所在的 shell 中通过 `glab mr view <number> --repo <repository> --output json --jq .web_url` 解析，沿用该 shell 的 `glab` 配置与 `GITLAB_HOST`。`glab api` 绑定其 REST 路径指向的 merge request，例如 `projects/group%2Fapp/merge_requests/7/changes`（可带前导 `/` 或 `api/v4/`，也可以是完整 API URL）：`--hostname` 或 URL 写明主机时直接绑定，否则通过 `glab mr view <number> --repo <path>` 解析，`:fullpath` 与 `:id` 占位符则不带 `--repo`；数字项目 id 不指向任何 merge request。

一次读取按主机分组引用，把每组拆成每批 `statusBatchSize` 个合并请求（默认 2），同时最多运行 `maxConcurrentRequests`（默认 4）个 GraphQL 查询。GitLab 拒绝复杂度超过 250 的查询，一个有 20 位评审者、20 位批准者和 50 个作业的合并请求单独就接近这个上限，所以被拒绝的批次会对半拆分后重读。可合并性取自 `detailedMergeStatus`、`mergeStatus` 与 `conflicts`。查询把合并状态放在 `diffStatsSummary` 之前，因为放在其后时 GitLab 19.5 会对它判定为可合并的合并请求报告 `CONFLICT`。`UNCHECKED`、`CHECKING`、`PREPARING` 和 `APPROVALS_SYNCING` 为未知；GitLab 在变化后尚未重新检查的合并状态（`UNCHECKED` 或 `CANNOT_BE_MERGED_RECHECK`）也为未知，不论其上次结果如何。GitLab 只有在 REST 读取该合并请求时才会重新检查，所以轮询会发出一次这样的读取，由之后的轮询读到结果。其余情况下，`CONFLICT` 即使 `conflicts` 为 false 也算冲突。合并请求打开、不是草稿、状态为 `MERGEABLE`、没有冲突，且当前用户可以合并时，才算可以合并。项目的快进合并设置把合并方式从 `merge` 换成 `rebase`，合并请求的压缩设置决定增加、强制或省略 `squash`。有评审者的状态为 `REQUESTED_CHANGES` 时评审结论为 `changes-requested`，GitLab 报告已批准时为 `approved`，`NOT_APPROVED` 时为 `review-required`。评审者在前，随后是不在评审者中的批准者，作者永远不列出；仍在等待其评审的评审者算作已请求评审，评审者状态映射为 `approved`、`changes-requested`、`commented` 和 `dismissed`。检查即 head 流水线中未被重试取代的作业：允许失败的失败作业为 neutral，手动作业为 pending，允许失败的手动作业为 skipped，汇总取流水线的状态。每个作业以其流水线的全局 id 作为 `rerun`，因为 GitLab 会一并重试一条流水线中失败和取消的作业；`canRerunChecks` 取决于当前用户能否更新 head 流水线。轮询读取前 50 个作业；`fetchChecks` 按每页 100 个读取其余作业，head 变化的页会被拒绝。当两个分支已分叉且没有冲突、没有正在进行的变基，并且用户可以推送到 head 分支时，`branchUpdates` 提供 `rebase`，这是 GitLab 唯一的分支更新方式；`canRequestReviews` 取决于用户能否更新该合并请求。未解决数是 GitLab 可解决的讨论数减去已解决的讨论数。关闭的 issue 取自 REST 的 `closes_issues`，最多 25 个，只在合并请求的更新时间变化时重读；读取失败时保留上一次的列表并标记为截断。

`diff` 读取最新的 MR diff 版本（GitLab 每次推送都会记录一个），除非它的 head 就是所请求的提交，否则返回 `stale`；随后把该版本的逐文件 diff 拼成一个带 Git 文件头的补丁，按路径排序，与 GitLab 的原始补丁一致；对 GitLab 折叠或判定过大的文件，用两端提交上的文本在本地比较。`real_size` 以 `+` 结尾（GitLab 在超过其文件数上限时这样设置）的版本为 `too-large`。在实测的每个打开状态合并请求上，这个补丁除 Git 的 `index` 行外都与 GitLab 的原始补丁一致。`commits` 按从旧到新列出合并请求的提交，最多 `maxCommits` 个（默认 250），GitLab 的 `X-Total` 计数更多时，读取最旧那些提交所在的页。`compare` 读取两个提交之间的 `repository/compare`，GitLab 因超时停止的比较报告为 `too-large`；`mergeBase` 读取 `repository/merge_base`。`fileText` 读取完整提交上的 `repository/files/<path>/raw`。

`readReview` 按每页 100 个读取 REST 讨论，直到读满 `maxReviewThreads` 个讨论，同时按 GraphQL 分页读取当前用户在合并请求、每个讨论和每条笔记上的权限，以及用户的草稿笔记和批准情况，然后读取 diff 版本；最新版本必须在所请求的 head 上，否则读取返回 `stale`。讨论即第一条笔记是文本或文件位置上的 diff 笔记的讨论；概览上的讨论、图片上的讨论和没有笔记的讨论会被略去，系统笔记从讨论中去掉。GitLab 为每个讨论只保留一个位置，即讨论所在的行保持不变的最后一个 diff 版本：位置在 head 上的讨论得到 `current`，每个行级讨论都把这个位置保留为 `original`。GitLab 把多行讨论带到新版本时不移动它的 `line_range`，所以范围的第一行等于最后一行减去范围长度。过期讨论的 `diffHunk` 从其位置所在的 diff 中截取：GitLab 保留了该版本的文件时取该文件，否则比较位置的合并基础与 head 上的文件文本，因为合并请求合并后 GitLab 会丢弃较早版本的文件。这些补丁不会变化，会一直保留到超过 `maxCachedVersionBytes`（默认 16 MiB）；单个版本本身超过该值时，只服务本次读取，不予保留。用户可以评论时可以回复讨论，GitLab 允许用户解决某个讨论时可以解决它；GitLab 授予用户某条笔记的 `adminNote` 时可以编辑和删除它。用户的草稿笔记就是其待提交评审，id 为 `draft-notes`：草稿回复作为待提交评论加入所在讨论，文件位置上的草稿自成一个讨论，发布前不能回复或解决。GitLab 不报告草稿的创建时间，所以草稿带的是读取时间。`reviewEvents` 对可以评论的用户提供 `comment`；GitLab 允许其批准或其已批准时提供 `approve`，因为 GitLab 社区版允许作者批准自己的合并请求；只对评审者提供 `request-changes`，因为 GitLab 只为评审者记录这个结论。

`markReady` 调用 GraphQL 的 `mergeRequestSetDraft` mutation；`merge` 以 PUT 调用 `merge`，把 `sha` 设为确认过的 head，压缩方式时设置 `squash`，因此 head 变化后 GitLab 以 HTTP 409 拒绝，报告为 `stale`；是否删除 head 分支由合并请求自己的设置决定。

评审写入先读取最新的 diff 版本，除非其 head 就是确认过的提交，否则以 `stale` 拒绝。评论的位置指明该版本的合并基础、目标分支末端和 head：新增行给出新行号，删除行给出旧行号，其他行无论在 hunk 内外都给出两个行号；范围再附上带 GitLab 行码的 `line_range`。该版本 diff 中不存在的行会在写入任何内容之前被拒绝；未变化行上的评论读回时在新侧。`submitReview` 为单条评论新建一个讨论。一次评审把每条评论写成草稿笔记，结论为 `approve` 时在 head 上批准，再连同总结与评审状态发布所有草稿：`comment` 对应 `reviewed`，`request-changes` 对应 `requested_changes`；草稿或批准被拒绝时会删除它已写入的草稿。发布被拒绝后会重新读取草稿，因为 GitLab 可能先发布草稿、再拒绝总结：只有草稿全部仍在时才删除，否则结果为 `unknown`。删除失败时结果为 `unknown`，并给出可能残留的草稿数。用户持有草稿时拒绝提交评审，因为发布会把这些草稿一并发出。待提交的回复和评论都是草稿笔记，`submit-pending` 以同样方式发布它们，`discard-pending` 逐条删除，被拒绝时报告此前已删除的条数。用户已经批准时跳过批准，因为 GitLab 对第二次批准返回 HTTP 401。回复、解决、编辑和删除都走该合并请求自己的路径，所以 GitLab 会拒绝其他合并请求的 id。

`rerunChecks` 在 head 流水线有失败作业且没有 pending 作业时重试它。`requestReviews` 用 `mergeRequestSetReviewers` 添加新评审者，用 `mergeRequestReviewerRereview` 再次请求现有评审者；只能有一位评审者的合并请求（如 GitLab 免费版）会拒绝第二位，GitLab 也没有团队评审者。`reviewerCandidates` 在能看到该项目的用户中列出 GitLab 匹配到的最多 20 人，永远不含作者，也都不标记为建议。`updateBranch` 只做变基：GitLab 的变基请求不指明 head，所以提供方先读取 head，head 已变化时以 `stale` 拒绝；GitLab 接受请求后在后台变基。写入从不重试：4xx 答复为拒绝，即 `failed`，但 HTTP 401 为 `unauthenticated`，对合并或批准的 HTTP 409 为 `stale`；5xx 答复、没有状态码的答复和超过 `timeoutMs` 的写入为 `unknown`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

每个状态查询用别名读取多个合并请求，项目路径和编号作为变量传入，所以缺失的项目或合并请求只让它自己的别名失败。

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验，以及提供方与命令规则注册 |
| [`src/commands.ts`](src/commands.ts) | forge-session 据以绑定 merge request 的 `glab` 命令规则 |
| [`src/provider.ts`](src/provider.ts) | URL 映射、分批、关闭 issue 与 diff 缓存，以及操作 |
| [`src/api.ts`](src/api.ts) | 经 `glab api` 发出的 REST、GraphQL 与写入请求，以及失败映射 |
| [`src/status.ts`](src/status.ts) | 状态查询构造与快照映射 |
| [`src/diff.ts`](src/diff.ts) | 钉在版本上的补丁、比较、合并基础与文件文本 |
| [`src/commits.ts`](src/commits.ts) | 按从旧到新列出提交 |
| [`src/review.ts`](src/review.ts) | 讨论、草稿笔记与权限读取，以及到 head 位置和原始位置的映射 |
| [`src/writes.ts`](src/writes.ts) | 经讨论、草稿笔记和批准完成的评审写入与提交 |
| [`src/position.ts`](src/position.ts) | 由版本的文件 diff 推出 diff 笔记位置与行码 |
| [`src/overview.ts`](src/overview.ts) | 流水线重试、评审请求、评审者候选与变基 |
| [`src/pool.ts`](src/pool.ts) | 有上限的并发 |
| [`src/glab.ts`](src/glab.ts) | 在宿主上执行 `glab`，清理环境变量并施加限制 |
| [`src/urls.ts`](src/urls.ts) | 远端、合并请求与 issue URL 解析，以及项目路径校验 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Forge 注册表](../forge/README.zh.md)——提供方注册与共享轮询。
- [Forge 子系统](../../../docs/subsystems/forge.zh.md)——提供方契约与变更请求类型。
- [GitHub 提供方](../forge-github/README.zh.md)——本提供方在 GitHub 主机上的对应实现。

-----

<a id="model-experience"></a>
## 模型体验

无：提供方为宿主侧监听方和面板读写合并请求，不贡献模型上下文。

#### KV Cache 影响

无。提供方的输出只到达宿主侧监听方。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **宿主上的 GitLab CLI**——必须安装 `glab`，并为每个配置的主机登录；环境变量中的令牌不会被转发。不在 `hosts` 中的主机永远不会被读取；状态读取对它们的引用返回 `unavailable`，按 head 查找会在启动 `glab` 之前拒绝。SSH 远端使用其他主机名的主机，以及安装在路径前缀下的 GitLab，都无法识别。
- **没有已审阅标记**——提供方不保存已审阅标记，所以变更视图把它们保存在浏览器中，与 GitLab 自己的页面一样。
- **变基不校验 head**——在读取 head 与发出变基请求之间的推送也会被变基，GitLab 在后台变基失败时不会报告。
- **概览讨论**——不在文件上的讨论会计入 `unresolvedThreads`，但不会作为讨论返回。
- **机器人与草稿时间**——评论作者从不标记为机器人，草稿笔记带的是读取时间。
- **只读 CE 字段**——状态查询只读取社区版具备的字段；付费版的必需批准、代码所有者、建议的评审者和合并结果流水线都不读取。
- **速率限制**——每次轮询每批花费一个 GraphQL 查询，每个更新时间变化的合并请求再花费一个 REST 请求；一次评审读取每 100 个讨论花费一个 REST 请求和一个 GraphQL 请求，版本、草稿笔记和批准情况各一个，每个尚未缓存的过期文件最多两个；一次写入先读取最新版本，一条评论只读取一次其版本的文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
