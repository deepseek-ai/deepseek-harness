---
description: "通过一个提供方无关的服务注册代码托管提供方并轮询变更请求状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge

[English](README.md) | 中文

## 概述

读取并操作 pull request 与 merge request，而不把消费方绑定到某一个代码托管平台。提供方把远端 URL 和变更请求（change request，即 pull request 或 merge request）URL 映射为提供方无关的引用，按 head 分支查找变更请求，批量读取其状态，读取其 diff 与文件，读取和写入其评审讨论，并按请求把草稿标记为可评审或合并变更请求。同一变更请求的所有监听方共享一个轮询循环，轮询节奏随检查、可合并性与生命周期状态变化。

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

将注册表与至少一个提供方包一起挂载，例如 GitHub 提供方。

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
```

`ctx.forge.register(provider)` 是调用方 fiber 上的 effect，返回异步 disposer，取消并等待该次注册的调用结束。取消后到达的结果会被丢弃。一个提供方在其 `hosts` 列出的主机上服务一个 forge 家族，并用 `label`（例如 `GitHub`）和 `changeRequestNoun`（`pull-request` 或 `merge-request`）称呼自己；为同一家族注册第二个提供方，或注册一个列出了已注册提供方所列主机（不区分大小写）的提供方，都会抛错。注册变化会发出 `forge/providers-changed`；注册提供方会立即轮询其已有监听。`repositoryFromRemote(url)` 与 `changeRequestFromUrl(url)` 返回服务该 URL 主机的提供方的匹配结果；`describe(forge)` 返回一个家族的 `ForgeDescription`，即它的 `label` 与 `changeRequestNoun`，没有提供方时返回 undefined。`changeRequestUrl(ref)`、`findByHead(repository, branch, signal)` 与 `readiness(repository, signal)` 委托给引用所属 forge 的提供方，没有注册提供方时抛错；`readiness` 报告提供方能否用当前凭据访问该主机；无法登录时还在 `signIn` 中给出让用户登录的 shell 命令。

`markReady(ref, signal)` 把草稿标记为可评审；`merge(ref, { method, headSha }, signal)` 只在 head 仍是 `headSha` 时合并变更请求。两者都委托给引用所属 forge 的提供方，没有注册提供方时抛错；主机接受时 resolve 为 undefined，否则为 `ForgeActionFailure`：`unauthenticated`、head 已越过 `headSha` 时的 `stale`、带主机原因的 `failed`，或主机的答复无法确认结果时的 `unknown`：此时改动可能已经生效，再次尝试前必须先到主机上核对。两者结束后，被监听的变更请求会立即重新轮询。快照带有 `mergeReady`（主机现在是否会为已登录用户合并该变更请求）与 `mergeMethods`（仓库接受的合并方式，该用户常用的方式排在最前）。

`diff(ref, headSha, signal)` 读取托管平台计算出的变更请求在 head 提交 `headSha` 处的统一补丁，路径带 `a/` 与 `b/` 前缀；`fileText(ref, commit, path, signal)` 读取其仓库中某个提交下的一个文件。两者都委托给引用所属 forge 的提供方，没有注册提供方时抛错，resolve 为文本或 `ForgeFailure`；托管平台或提供方因结果超过其大小上限而拒绝时，失败为 `too-large`。提供方只在补丁描述 `headSha` 时返回补丁；head 已是其他提交时，`diff` resolve 为 `stale`。同一 head 提交的第一次 stale 读取会让被 watch 的变更请求立即重新轮询，使下一次状态给出当前 head；之后在该提交上的 stale 读取等待常规轮询，从而在托管平台的应答短暂不一致时限制读取次数。被 watch 的变更请求的最新状态给出 `headSha` 并携带 `baseSha`（托管平台随该 head 记录的基准提交）时，`diff` 把它传给提供方，提供方可以在确认 head 之前就从它开始读取。快照携带 `unresolvedThreads` 与 `threadsTruncated`；提供方只统计了部分评审讨论时，后者表示该计数只是下限。`fileUrl(ref, commit, path)` 返回该文件在该提交下的网页地址。

提供方可以同时实现 `commits` 与 `compare`。`commits(ref, signal)` 在一个 head 提交上按从旧到新列出变更请求的提交，每个提交带完整对象名、第一个父提交、标题、作者与作者时间，并带 `truncated` 标志；`compare(ref, base, head, signal)` 读取从提交 `base` 到提交 `head` 的统一补丁。提供方缺少其中任一方法时，注册表的 `commits` 返回 undefined，`compare` 返回 `unavailable` 失败，因此使用方只在两者都存在时提供按提交查看。

提供方可以同时实现 `viewedFiles` 与 `setViewed`。`viewedFiles(ref, headSha, signal)` 在 head 提交 `headSha` 上读取当前登录用户对变更请求各文件的已审阅标记，每个文件为 `viewed`、`unviewed`，或在标记后又有改动时为 `dismissed`，并带 `truncated` 标志；`setViewed(ref, { path, viewed, headSha }, signal)` 仅在 head 仍是 `headSha` 时设置或清除一个文件的标记。两者都把已移动的 head 报告为 `stale`，并像过期的 `diff` 一样立即轮询被监听的变更请求。提供方缺少其中任一方法时，`viewedFiles` 返回 undefined，`setViewed` 返回 `failed` 失败，因此使用方自行保存已审阅标记。

提供方可以实现 `mergeBase(ref, base, head, signal)`，给出变更请求 diff 旧侧所显示文件所在的提交；缺少它时 `ctx.forge.mergeBase` 返回 `unsupported`。托管平台接受一次评审写入、一次评审提交或一个已审阅标记后，注册表以该变更请求和这次变化发出 `forge/review-changed`，无论是哪个插件做的；结果未知、被拒绝、已过时或不支持时不发出。[扩展 API](../../../docs/subsystems/forge.zh.md#extension-api) 列出其他插件可以依赖的内容。

快照携带变更请求的概览。`reviewers` 先列出被请求的评审者，再列出每个账号最近一次评审的结论及其所针对的提交；`closingIssues` 列出变更请求合并时代码托管平台会关闭的 issue；`reviewersTruncated` 与 `closingIssuesTruncated` 标记提供方只读取了部分的列表。`branchUpdates` 列出能让落后于基线的 head 为当前登录用户更新的方式；head 已是最新、存在冲突或不允许更新时为空，因此使用方无法告诉没有更新权限的用户 head 已落后。`canRequestReviews` 与 `canRerunChecks` 说明当前登录用户的权限，每个检查的 `rerun` 指出能重跑它的托管平台运行，否则为 null；指向同一运行的检查一起重跑，且要等其中没有检查仍在进行。

提供方可以实现 `rerunChecks(ref, { headSha }, signal)`，重跑 head 提交 `headSha` 中所在运行没有进行中检查的失败检查；可以同时实现 `requestReviews(ref, { reviewers }, signal)` 与 `reviewerCandidates(ref, query, signal)`，后者列出可以请求评审的账号，托管平台的建议排在最前；还可以实现 `updateBranch(ref, { method, headSha }, signal)`，仅在 head 仍是 `headSha` 时把基线合并或变基进 head。每个操作在托管平台接受后返回 undefined，否则返回 `ForgeActionFailure`，结束后会立即轮询被监听的变更请求。提供方缺少某个操作时，注册表以 `failed` 失败返回且不轮询；除非提供方同时实现两个评审请求方法，`reviewerCandidates` 返回 `unsupported`。

`fetchChecks(ref, signal)` 按需读取单个变更请求的完整检查，使用独立的 `fetchTimeoutMs` 时限，不占用轮询批次，也不向其监听方发布结果。读取失败时保留已有轮询快照。提供方未实现 `fetchChecks` 时返回 `unavailable`。调用方取消、提供方或服务销毁都会中止读取；销毁会等待读取结束。

`ctx.forge.watch(ref, listener, options)` 同样是 effect。它监听变更请求的快照：第一个快照监听方会立即触发轮询；之后加入的监听方传入 `maxAgeMs`、最近一次结果比它更旧、且没有快照轮询在进行时，也会立即触发。`latest(ref)` 返回最近一次快照结果；只剩简报监听方时，这个结果仍然保留。`ctx.forge.watchBrief(ref, listener, known)` 监听变更请求的简报：标题、状态、草稿标记、可合并性、评审结论与检查汇总结果。变更请求有快照监听方时，轮询读取快照，简报监听方收到快照里的简报。否则轮询通过提供方的 `fetchBriefs` 读取简报；提供方没有该方法时读取快照。尚无监听方的变更请求迎来第一个简报监听方时会立即轮询，除非它用 `known` 传入自己已知的状态；这时首次轮询按“在 `known.fetchedAt` 读过一次”来安排，已合并的变更请求不轮询。每个 forge 同时最多有一次快照读取和一次简报读取在进行。每次读取包含该 forge 在对应层级上所有到期的变更请求，以及距上一次状态的等待已过半的变更请求，所以在不同时刻到期的变更请求会逐渐共用一次读取。打开状态的变更请求在检查未完成时每 `activeIntervalMs` 轮询一次，否则每 `idleIntervalMs` 轮询一次。状态第一次报告可合并性未知时，`activeIntervalMs` 后再轮询一次；再次报告未知的变更请求等待 `idleIntervalMs`，因为有些变更请求不会再报告其他值。已关闭的变更请求按 `idleIntervalMs` 轮询以检测重新打开；已合并的停止自动轮询。`refresh(ref)` 立即轮询一个被监听的变更请求，已结束的也包括在内；该 forge 在同一层级已有读取在进行时，等待其结束后立即再读一次。`refresh(ref, { maxAgeMs })` 要求不早于 `maxAgeMs` 的状态：任一层级最近一次轮询（正在进行或已结束）在 `maxAgeMs` 之内开始的变更请求不触动，已合并的也不触动。`expectChange(ref)` 预告一个被监听的变更请求即将变化，例如它的 head 分支刚被推送：立即轮询一次，之后每 `activeIntervalMs` 轮询一次，直到状态报告检查正在运行、或变更请求已关闭或已合并为止，最长持续 `idleIntervalMs`。读取失败后，重试间隔为 `activeIntervalMs` 按连续失败次数翻倍，最长 `maxBackoffMs`；该值必须大于或等于 `activeIntervalMs`；在此之前该变更请求不加入其他读取。简报读取失败只通知简报监听方，`latest(ref)` 不变；快照读取失败会通知两类监听方。注销提供方会让其被监听的变更请求以 `unavailable` 结束。两类监听方都离开后轮询停止。默认值见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-forge)。

提供方可以声明 `snapshotBatchSize` 与 `briefBatchSize`，即一次 `fetch` 轮询调用和一次 `fetchBriefs` 轮询调用最多读取同一主机的多少个变更请求；两者都必须是正安全整数，否则注册被拒绝。这时一次读取按主机（不区分大小写）对到期的变更请求分组，每这么多个调用提供方一次，依次调用，并在每次调用返回时发布它的结果；所以某次调用失败或超过时限时，只有它读取的变更请求失败。没有声明大小时，一次调用读取该 forge 所有到期的变更请求。等待调用期间失去最后一个监听方的变更请求不再读取；等待期间监听方改变了轮询读取内容的变更请求，由对应层级的读取来读。

每次提供方调用都有自己的 `fetchTimeoutMs` 时限。达到时限时，该调用的信号会以 `FORGE_FETCH_TIMEOUT` 中止。提供方必须在信号中止时停止工作并结束请求；被拒绝的调用会转为它所读取的变更请求的 `unavailable` 失败。忽略取消的提供方可能阻塞轮询和服务销毁。

provider 可以实现 `submitReview`，在指定的 head 提交上发布行内评论或完整评审。未实现该能力时，注册表返回不支持；提交结束后会刷新受关注的状态。成功的写操作返回网页 URL；失败区分 head 变化、明确拒绝与结果不明。调用方必须先核对结果不明的操作，再次提交。用户留待之后一起提交的评论通过 `writeReview` 写入代码托管平台的待提交评审，不由轮询注册表保存。

提供方可以实现 `readReview`，在一个 head 提交处读取变更请求的评审讨论。只有读取时的 head 就是 `headSha` 时，`readReview(ref, headSha, signal)` 才返回 `ForgeReviewData`，其中每个行级讨论都带有它在 head 上的位置和在写下时所在提交上的位置，`reviewEvents` 列出托管平台允许当前用户在提交的评审中记录的结论；否则返回 `stale`，并立即重新轮询被关注的变更请求，每个 head 提交只轮询一次，这个次数与 diff 读取遇到 `stale` 时共用。提供方未实现该方法时，注册表返回 `unsupported` 失败。

提供方可以实现 `writeReview`，修改变更请求的评审讨论和当前登录用户的待提交评审。`writeReview(ref, write, signal)` 接收一个 `ForgeReviewWrite`：回复讨论，立即发布，或在 `pending` 时加入待提交评审；把讨论标记为已解决或取消解决；编辑或删除评论；在 head 上添加一条行内评论到待提交评审；或提交、丢弃待提交评审。用户还没有待提交评审时，待提交的回复或评论会先开始一个评审。只有 head 仍是 `write.headSha` 时提供方才会写入；否则返回 `stale`，并像读取遇到 `stale` 时那样重新轮询被关注的变更请求；其他结果之后，注册表都会立即重新轮询被关注的变更请求。写操作从不重试；结果为 `unknown` 时，必须先在托管平台上核对，再重试。提供方未实现该方法时，注册表返回 `unsupported`。`ForgeReviewData` 给出用户的待提交评审，以及用户能否回复和解决每个讨论、编辑和删除每条评论、向待提交评审添加评论并提交或丢弃它；未实现 `writeReview` 的提供方不报告任何这类权限。

提供方可以声明 `viewer`（它为登录用户列出变更请求的主机、提供的列表与 `maxItems`），并同时实现 `listForViewer` 与 `countForViewer`；`ctx.forge.viewerSources()` 列出所有这样的提供方。`listForViewer(query, signal)` 在一个主机上读取 `review-requested`、`authored` 或 `involved` 中的一个列表，可限定一个仓库，按最近更新在前；`countForViewer(host, signal)` 读取每个列表的总数。主机按限流拒绝时返回失败代码 `rate-limited`。提供方还可以实现 `readDescription(ref, signal)`，读取变更请求的 Markdown 描述、标签，以及浏览器无需用户托管平台会话即可加载的图片地址。提供方、主机或列表不提供读取时，注册表返回 `unsupported`。这些读取都不进入状态轮询。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

一个定时器覆盖所有被监听的变更请求。定时器触发时，服务按 forge 和轮询读取的内容对到期的变更请求分组，把等待已过半的变更请求加入对应分组，并为上一次读取已结束的每个分组发起一次批量读取。抛错的监听方会被记录日志并跳过。销毁服务会中止进行中的读取，并等待它们结束。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方注册、URL 映射、监听生命周期与批量轮询 |
| [`src/schedule.ts`](src/schedule.ts) | 计算单个变更请求距下次轮询的延迟 |
| [`src/keys.ts`](src/keys.ts) | 变更请求不区分大小写的规范标识 |
| [`src/types.ts`](src/types.ts) | 仓库、变更请求、状态与提供方类型 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Forge 子系统](../../../docs/subsystems/forge.zh.md)——提供方契约、变更请求类型与服务参考。
- [GitHub 提供方](../forge-github/README.zh.md)——服务 GitHub 主机的提供方。
- [Session 绑定](../forge-session/README.zh.md)——把变更请求绑定到 Session 的消费方。
- [绑定决策](../../../.agents/notes/implemented/feature/2026-10-09-session-change-request-bindings.zh.md)——为何绑定从 shell 结果派生、状态只留在宿主侧。

-----

<a id="model-experience"></a>
## 模型体验

无：提供方与监听方只交换代码托管平台的状态，不贡献模型上下文。

#### KV Cache 影响

无。任何模型请求都不包含本包的数据。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅轮询**——状态在下一次计划轮询或 `refresh` 时才送达监听方；没有 webhook 接入。
- **结果只在进程内**——最近结果保存在内存中，重启后丢失；下一个监听方会重新轮询。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
