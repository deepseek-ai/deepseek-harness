---
description: "展示 Session 创建的变更请求、并让新 Session 以 worktree 开始的 GUI 面板，以及为它们提供数据的宿主 Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-forge

[English](README.md) | 中文

## 概述

这个可选包展示 Session 创建或推送的变更请求及其变更，并让新 Session 在自己的 Git worktree 中开始。宿主端的 `forgePanel` Remote 使用 Session 的权限检查检出，检查代码托管平台的登录状态，为单个 Session 或会话列表以流的形式推送[已绑定变更请求](../forge-session/README.zh.md)及其轮询状态，读取 diff，并在第一条消息于 Session 的收件箱中等待时创建所请求的 worktree。客户端增加一个侧边栏标签页、一个变更视图、标题栏中的入口、一个新会话选项、一张创建卡片、会话列表中的图标，以及 toast 提示。

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

在插件页启用 [forge 套件](../forge-bundle/README.zh.md)；它把本包与 forge 注册表、GitHub 提供方、Session 绑定以及它自己的 [worktree 服务](../worktree/README.zh.md)组合在一起。

面板文案跟随应用语言，支持中文、英文、日语、西班牙语、法语、德语、俄语和葡萄牙语。

- **工作树选项**——在新会话页面上，“新建工作树”与当前分支一起位于工作区与模式选择器那一行的右端。不在 Git 检出中时，两者均隐藏。分支默认为只读展示；勾选“新建工作树”后，它变为基准分支选择器，菜单列出最近的本地分支。权限阻止已有请求时，仍只读显示已选基准，并允许取消请求。悬停、聚焦或轻点只读分支或基准会显示完整说明。Session 为只读，或检出及其 Git 目录不在 Session 的可写根内（例如项目本身就是链接 worktree）时，该选项不可用，提示中说明原因。发送第一条消息后，消息立即交给 Session 并在那里等待，同时从基准分支在仓库的 `.agents/worktrees/` 下创建分支 `dsh-<Session id 前 8 位十六进制数>-<4 位随机十六进制数>`，并把它的检出设为 Session 的工作目录；worktree 建好后这条消息的这一轮才开始。
- **创建卡片**——创建 worktree 期间，输入框上方的卡片显示新分支以及“创建分支”“检出文件”两个步骤；“更多详情”会列出分支与基准。“取消”停止这次尝试。尝试被停止或失败后，消息继续等待，失败时卡片显示原因：“重试”换一个新分支名再试；“不使用工作树”撤回请求，消息在当前检出中继续发送。
- **工作树已被删除**——Session 所在的 worktree 在 Session 之外被删除后，输入框上方的卡片会说明这一点；此期间发送的消息会等待、不开始这一轮，直到该 worktree 被恢复或离开，卡片也会说明消息之后会接着发送。“恢复工作树”（标签页中的“恢复”与之相同）在原目录重新检出该分支；分支也已删除时，从它开始时的提交重新创建分支；恢复期间卡片显示“准备工作树”“检出文件”两个步骤，标签页中的“恢复”变为加载状态。“在项目目录继续”把 Session 移回源检出。此期间标签页顶部一行显示警示图标。
- **代码审查和变更**——右侧栏起始页中的入口，与会话标题栏按钮打开同一个变更请求标签页。
- **标题栏按钮**——Session 有已绑定的变更请求、或其目录位于 Git 检出中时出现，用来显示或隐藏标签页。打开状态的变更请求存在检查失败、被要求修改或冲突时，按钮带红点。
- **会话列表**——Session 在面板为它创建的 worktree 中工作时，会话行的时间之后显示分支图标；另有一个图标显示它最需要关注的变更请求的状态，依次为需要处理、打开、草稿、尚未轮询、已合并、已关闭。打开中的变更请求图标保持会话行的浅色，并用圆点标出检查进行中、已通过或失败；已合并与已关闭的保留各自的状态颜色。会话行的悬浮卡片写出 worktree 分支及其起点，再列出最多三个变更请求的编号、标题、状态与检查，并说明还有多少个。重启后，下次轮询之前显示重启前已知的状态。
- **标签页**——顶部一行显示当前检出的分支（分离 HEAD 时为缩写提交），项目目录前显示目录图标、worktree 前显示分支图标，并说明检出的类型（Session 创建的 worktree 及其基准、其他 worktree 或项目目录）；它的提示给出路径，宿主主目录缩写为 `~`，旁边的按钮复制完整路径；worktree 已被删除时提供“恢复”。其下每张变更请求卡片显示状态图标、标题（点击在浏览器中打开）与编号；图标区分打开、草稿、已合并与已关闭，打开中的变更请求（草稿除外）检查失败、被要求修改或有冲突时显示为“需要处理”，与标题栏按钮的红点一致。卡片右上角还提供“在浏览器中打开”“复制变更请求链接”与“从本会话移除”，移除后的 toast 提供“撤销”。已取消的检查单独计数；列出的检查没有失败项时，折叠卡片显示取消数量。折叠的卡片还显示打开的变更请求的检查，以及被要求修改、冲突、草稿中最需要注意的一项；已合并或已关闭的则显示结束时间。展开的卡片显示源分支与目标分支，下面每项一行：打开的变更请求依次是检查（点击该行弹出检查列表，失败的排在前面，带耗时与链接）、评审结论与未解决讨论数、合并状态，已合并或已关闭的显示结束时间；最后是按所选界面语言格式化的变更行数，点击该行打开变更视图。打开中的草稿还提供“标记为可评审”；主机现在就会合并的变更请求提供“合并”，其菜单列出仓库允许的合并方式并选中用户常用的一种，打开时固定卡片显示的 head。“确认合并”使用这个 head；轮询发现 head 变化后禁用确认，需重新检查并打开菜单。每次操作的结果都以 toast 报告；该 head 之后有新提交时不会合并。恰好有一个已绑定的变更请求处于打开状态时，它的卡片默认展开。刷新会重新检查检出与登录状态，并立即再次轮询每个变更请求；检查与登录状态确认结束前，刷新图标持续旋转。缺少登录时，横幅显示 `gh auth login` 命令。
- **本地变更卡片**——`branch` 范围有文件变更、且没有以当前检出分支为源分支的打开中变更请求时，变更请求列表上方的卡片显示比较的基准（例如 `HEAD → origin/main`）以及新增、删除行数与文件数，点击打开变更视图；展开的文件列表像变更视图一样标出各个文件，点击某个文件时，变更视图定位到该文件。识别出代码托管仓库后，卡片提供“创建变更请求”：它以界面语言向 Session 发送一条用户消息，请 Agent 为这些变更创建变更请求，并以 toast 报告是否已发送。
- **变更视图**——展开的变更请求卡片上的“变更”一行与本地变更卡片会打开一个右侧边栏标签页，列出所有变更的文件。本地标签页名为“本地变更”，默认显示“分支”：工作树与未跟踪文件相对于分叉点的变更；分叉点是 Session 创建的 worktree 的基准提交，否则是 HEAD 与代码托管远端默认分支的合并基准。“未提交”与 HEAD 比较，“未暂存”与暂存区比较，“已暂存”比较暂存区与 HEAD。变更请求的视图显示托管平台在其 head 处的 diff；当前检出分支就是该变更请求的源分支时，还会说明本地分支比该 head 多出几个提交。工具栏可以跳到某个文件、汇总变更行数、刷新，并在左右对比与单栏对比、自动换行与截断长行之间切换。访问过的变更标签页会在切换标签页与 Session、隐藏侧边栏及调整停靠位置时保持挂载，在 diff 未改变时保留文件折叠、大文件展开、上下文展开、布局与滚动位置。隐藏的变更视图释放面板订阅并推迟 diff 读取；返回时仅在最新 head 或本地摘要不同时重新读取。刷新替换 diff 后会丢弃展开的上下文，内容变化也可能移动阅读位置。视图隐藏时关闭临时菜单。关闭标签页或重新加载应用后不保留这些进度。文件名在前，目录在后，用更小的浅色字显示，空间不够时目录先缩短；悬停时显示完整路径，重命名的文件显示新旧两条路径。每个文件带有新文件、已删除、重命名的标记（重命名标记写出原文件名，只换了目录时写出原路径），“分支”范围下的未跟踪文件还标“未提交”；文件菜单可以复制路径，本地变更可在侧边栏打开整个文件，变更请求可在浏览器中查看该文件在 head 处的页面。hunk 之间未变更的行折叠成一行，点击后从文件的新版本展开：工作树、“已暂存”时为暂存区，或经托管平台读取的 head 提交；读取 diff 之后文件又有修改时不会展开，直到视图重新读取。二进制文件与超过 `maxDiffBytes` 的未跟踪文件只显示一条说明；hunk 超过 1,000 行的文件先显示为一条写出变更行数的折叠条，点击后才绘制；前面的文件累计变更超过 5,000 行后，其后的文件默认收起。刷新与页面刷新快捷键、每次导航、变更请求的 head 变化，以及“分支”范围的摘要变化时，视图都会重新读取；变更请求的视图会先等到给出 head 的状态再读取，除非没有提供方服务它或那次轮询失败。重新读取已显示的变更时，刷新图标会旋转。托管平台或其提供方因超过大小上限拒绝给出 diff 的变更请求（例如 GitHub 上超过 300 个文件的 diff）显示“变更太大，无法在这里显示”并提供“在浏览器中查看”；其他读取失败提供“重试”，变更请求还提供“在浏览器中查看”。变更请求的 diff 在缓存期间对每个 head 提交与目标分支只下载一次，因此在同一 head 下重新打开、刷新与导航都不会再从托管平台读取。

检查行先显示轮询预览。不完整时，卡片使用托管平台的总体状态而不显示失败总数，并注明已加载的检查数量尚不完整。打开列表后，经 `changeRequestChecks` 单独读取该 PR 的后续页，时限独立于轮询。读取失败时保留预览并提供重试。关闭列表、head 变化或组件卸载会取消读取，忽略迟到结果；重新打开会读取当前详情。Remote 要求 URL 是该 Session 可见的绑定，并拒绝 head 提交不一致的响应。

点击 diff 内容区可将焦点移入。左右方向键按 diff 顺序跳到上一个、下一个文件并展开它；到达首尾时停留。上下方向键保留原有滚动行为。手动滚动后，文件跳转从视口顶部的文件继续。文本编辑、非折叠文本选区、组合键、菜单与文件树控件保留各自的键盘行为。

`gitCommand`、`gitTimeoutMs`、`graceMs`、`maxOutputBytes`、`readinessTimeoutMs`、`maxBranches`、`worktreePrefix`、`maxDiffBytes`、`maxUntrackedFiles` 与 `maxCachedDiffBytes` 列在[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-client-ui-forge)中。

“全部文件”打开可搜索的目录树；只有一个子目录的路径会合并显示，重命名文件也可以按旧路径搜索。较宽的变更面板会在 diff 旁显示同一棵树，工具栏的“文件树”按钮按“左侧 → 右侧 → 隐藏”循环切换，默认显示在左侧。按钮的无障碍名称说明下一步操作，移动或隐藏文件树时焦点仍留在按钮上。移动或隐藏文件树，以及切换标签页与 Session 时保留搜索、折叠状态、选中文件和宽度。拖动分隔线，或聚焦分隔线后使用方向键，可以调整文件树宽度。文件与文件夹预留相同的展开箭头列，子项相对父目录向内缩进。本地变更与每个 PR 保留独立标签页。划选代码文字或通过行号选择同一已显示 hunk、同一侧的连续行，文字划选与复制都限定在起始侧。点击“＋”才打开纯文本评论框。评论框支持换行和输入法组合输入，只有点击操作按钮才提交。可拖动底边调整高度。“添加到输入框”将评论作为可移除的引用加入主输入框，多条引用只会在用户发送主输入框时一起发送。GitHub 分段按钮用于开始或加入待提交评审，下拉菜单可以立即发布单条评论。评论在引用、暂存或发布后保留在对应代码旁，暂存评论可在那里编辑或删除。“请求更改”需要填写评审总结，弹窗在总结输入框旁说明此要求，并在切换评审决定时播报。PR 标题栏中的“提交评审”打开居中弹窗，只显示待提交数量、总结以及“评论”“批准”“请求更改”选项。新建和删除文件只显示有内容的一侧行号。待提交评审与评论记录按 Session 和页签保存在当前浏览器，包括最初评审的 head。切换 Session 或隐藏面板时保留；关闭页签会清空该页签的评论、总结与评审决定，重新打开从空评审开始。已发布到 GitHub 的评论与已加入主输入框的引用不受影响。head 变化后需要重新选择评论行。代码变化后的记录保留在文件末尾；文件已不在 diff 中时，记录显示在 diff 之后。页签保持打开时，结果不明的提交在重新加载后仍会阻止重复发送，直到用户检查 GitHub 并明确允许再次提交。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`ForgePanelController` 为每个被关注的 Session 保留一个 `SessionPanel`，最后一个关注方离开时销毁它。面板从 Session 的工作目录与绑定开始，在每个 `working-directory/change`、`tool/result` 与 `sandbox/mode` 事件之后重新检查，每次变化都发布新的 `ForgePanelState`。每个变更请求在后续轮询失败时保留最近一次轮询得到的快照。并行 Git 读取失败时会取消并等待同批读取结束。检查一次只运行一个，最多再追加一次；Session 已离开的目录的结果会被丢弃。代码托管平台按远端顺序识别：先是上游所在的远端，然后是 `origin`，最后是其余远端。检查发现提供方识别的远端上有上游分支时，面板调用 `ctx.forgeSession.discoverBranch` 绑定该分支打开状态的变更请求；同一远端与分支在刷新前只查找一次。识别出的托管平台变化时以及刷新时，会在 `readinessTimeoutMs` 内检查登录状态；一次刷新在它触发的检查与登录状态检查结束后完成，轮询结果之后才到达。

检查运行 `rev-parse --show-toplevel`、`rev-parse --path-format=absolute --git-common-dir`、`rev-parse --path-format=absolute --git-dir`、`symbolic-ref --short HEAD`、`rev-parse --short HEAD`、`rev-parse --abbrev-ref @{upstream}` 与 `remote -v`；`branches` 运行 `symbolic-ref` 与 `for-each-ref --count=<maxBranches>`。之后，检查会为本地变更卡片统计 `branch` 范围的规模：找出分叉点，对它运行 `diff --numstat -z -M`，采用与下文 `localDiff` 相同的辅助程序和子模块限制，并列出未跟踪文件。每个命令都使用 Session 解析出的沙箱模式：`read-only` 与 `workspace-write` 需要沙箱，`danger-full-access` 无需沙箱后端。命令禁用可选的索引写入、钩子、文件系统监视器、提示与对象的延迟获取，移除继承的 Git 选择器与携带密钥的变量，并各自受 `gitTimeoutMs` 时限与每个输出流的 `maxOutputBytes` 上限约束。Git 打印的顶层目录、Git 目录与公共 Git 目录经 `ctx.fs` 解析为工作目录服务记录的规范进程路径；Git 目录与公共 Git 目录不同的检出是链接 worktree。工作树选项在 `danger-full-access` 沙箱模式下可用，在 `read-only` 下不可用，在 `workspace-write` 下只有两个目录都位于 Session 沙箱策略的规范工作区根内时才可用。

worktree 请求是一条 `plugin:client-ui-forge/worktree` 记录，由 `forgeWorktree` 投影折叠：请求与撤回在第一个 `turn/start` 或创建之前生效；在第一个 `step/start` 之前，未完成请求的第一条 `created` 记录生效。该投影还从 Session 头部与每个 `working-directory/change` 记录 Session 的目录；它的客户端视图随 Session 摘要下发，在该目录就是所创建的 worktree 或位于其下时为该 worktree，否则为 null。一轮开始或 worktree 已创建之后，`requestWorktree` 以 `forgePanel/session-started` 拒绝；没有 `worktrees` 服务时以 `forgePanel/worktrees-unavailable` 拒绝；分支名为空时以 `forgePanel/invalid-branch` 拒绝；`cancelWorktree` 只以第一种拒绝，也不需要 `worktrees` 服务；两者都会忘掉失败的尝试。消息进入有未完成请求的 Session 的收件箱时，一个 `agent/inbox/inserted` 监听器在这次投递唤醒 Agent 之前启动 Session 所属 Agent 的维护任务，因此 Agent 会暂存唤醒，等这次暂留结束后才开始这条消息的这一轮。暂留使用新分支名进行一次尝试，在面板状态中发布正在进行的阶段，设置 `held`，`waiting` 为 `creation`，并记录带源仓库根目录的 `created`。尝试失败（其分支、基准、失败步骤与原因以 `failure` 留在面板状态中）或经 `stopCreation` 停止后，暂留继续等待：`retryWorktree` 再做一次尝试，没有消息等待或已有尝试进行时以 `forgePanel/not-waiting` 拒绝；撤回请求则让消息在当前检出中继续。Agent 空闲且 Session 在所创建 worktree 中工作时，进入的每条消息都会启动一次暂留，检查该 worktree 是否缺失；缺失期间暂留以 `waiting` 为 `restoration` 等待，`restoreWorktree` 或 `continueInProject` 在暂留内运行，之后放行消息；检查无法给出结果时立即放行。Agent 的取消与 Remote 的停止都会结束暂留；Agent 正在运行一轮或其他维护任务时进入的消息不会被暂留。worktree 服务把工作目录通知排进队列，由第一步认领。一个 `agent/pre-step` 监听器在请求仍未完成的 Session 的第 1 步创建 worktree，覆盖没有被暂留的消息；它把通知移入本步提议的消息，失败时这一轮结束、请求保留。没有消息等待时，`restoreWorktree` 与 `continueInProject` 以各自的维护任务运行；`restoreWorktree` 以 `restoration` 发布正在进行的步骤，并在结束恢复的同一状态中清除 `missing`。套件把它的 `worktrees` 服务隔离，因此同时启用 Git Worktrees 时会有两个互不影响的服务。`track` 以 `forgePanel/unrecognized-url` 拒绝没有提供方识别的 URL。`markReady` 与 `merge` 只作用于该 Session 中由提供方服务的可见绑定，否则以 `forgePanel/not-bound` 拒绝；`merge` 带上卡片显示的 head 提交，head 已变化时以 `forgePanel/stale-head` 拒绝，其他拒绝都是带主机原因的 `forgePanel/action-failed`。


恢复在修改前记录 `restoring`，仅在成功后记录 `restored`。投影版本 3 在重载后保留未完成的恢复。目录存在本身不能放行等待的消息：检出根目录与公共 Git 目录必须匹配记录的工作树。插件卸载会取消并等待所有创建、恢复与消息等待任务，然后释放面板读取器和投影。

每次检查还会判断 worktree 是否缺失：Session 的目录位于所创建的 worktree 内，`ctx.fs.lstat` 在那里找不到目录，再由源仓库中的 `show-ref` 判断分支是否还在。

Session 在所创建的 worktree 中工作时，`localDiff` 以它的 `baseCommit` 为分叉点；否则按代码托管远端的顺序，对每个远端依次运行 `symbolic-ref --quiet --short refs/remotes/<remote>/HEAD` 与 `merge-base HEAD` 找出分叉点；找不到时 `branch` 范围以 `forgePanel/no-fork-point` 拒绝。它以固定的 `a/`、`b/` 前缀和 `core.quotePath=false` 运行 `diff --no-ext-diff --no-textconv --submodule=short --ignore-submodules=dirty --no-color -M`，分别与分叉点、HEAD（第一次提交之前为空树）、暂存区比较，或带 `--cached` 与 HEAD 比较。读取补丁与统计前会查询 Git 配置，应用命令级 clean/process filter 覆盖。配置读取失败或被截断时停止比较：`localDiff` 报告 `forgePanel/filter-config-failed`，修正 Git 配置或读取上限后可重试；统计失败时本地变更卡片保持隐藏。过滤器枚举在读取补丁时使用 `maxDiffBytes` 上限，统计时使用 `maxOutputBytes` 上限。未跟踪文件由 `ls-files --others --exclude-standard -z` 列出，最多 `maxUntrackedFiles` 个，其余计为未列出；它们经 `ctx.fs` 读取并作为新文件加入，前 8,000 字节含 NUL 字节或不是 UTF-8 时视为二进制。补丁、文件列表或文件超过 `maxDiffBytes` 时以 `forgePanel/diff-too-large` 拒绝，目录不在检出中时以 `forgePanel/not-a-checkout` 拒绝。宿主用 jsdiff 把补丁解析为文件与 hunk，浏览器不会收到原始补丁。`localText` 读取一个文件的新版本：“已暂存”经 `show :<path>` 从暂存区读取，其余经 `ctx.fs` 读取；离开检出的路径会被拒绝。`changeRequestDiff` 与 `changeRequestText` 只作用于该 Session 中由提供方服务的可见绑定，否则以 `forgePanel/not-bound` 拒绝；它们经提供方的 `diff` 与 `fileText` 读取绑定最新状态中的 head 提交，`too-large` 失败以 `forgePanel/diff-too-large` 拒绝，尚未读到状态或托管平台以其他原因拒绝时以 `forgePanel/diff-failed` 拒绝。Host 保留 `changeRequestDiff` 读到的补丁，每个变更请求一份，按 head 提交与目标分支区分，总量超过 `maxCachedDiffBytes` 时丢弃最久未读的；之后在同一 head 与目标分支下的读取不论来自哪个 Session 都从内存返回，读取失败的结果不保留。本地分支比 head 多出的提交数由 `symbolic-ref`、`cat-file -e` 与 `rev-list --count` 得出；当前检出分支不是源分支、本地没有 head 提交或 Git 失败时为 null。

`changeRequestStates` 为会话列表推送调用方可读的、已列出的 Session 所绑定的每个变更请求的最近编号、标题、状态、草稿标记、检查汇总、评审结论与可合并性：先是一个 `baseline` 帧，之后是 `changed` 帧。所有流共用一次运行。初始化之前和帧之间均响应取消；最后一条流结束及插件卸载会等待初始化与已接受的写入完成，再关闭本次运行的存储域。后续运行会等待该域关闭后重新打开，并读取已存状态。列举期间收到的绑定更新优先于初始快照。它经 `sessionQuery` 列出 Session 而不加载它们，已加载 Session 的可见绑定取自 `ctx.forgeSession`，其他 Session 的取自缓存的 `forgeChangeRequests` 摘要；它跟随已加载 Session 的绑定变化，并经 `ctx.forge.watch` 订阅每个已绑定的变更请求；已关闭的按空闲间隔轮询，已合并的保留订阅以接收显式刷新结果。每个变化了的状态以其 URL 的 SHA-256 摘要为键存入 `forge_panel_change_requests` 存储域，仅在所有已列出 Session 的绑定均已知时删除无人绑定的已存状态；写入失败时记录日志，状态仍保留在内存中。宿主缺少 Session 查询、投影缓存、存储或 Session 存储服务时，流以失败结束。

浏览器入口先挂载 Remote，再挂载界面。每个 Session 一条流，同时供给标签页、标题栏按钮、新会话选项与创建卡片；第一个订阅方出现时打开，最后一个离开时关闭，传输重置后重新打开，在 Session scope 保留期间保存最后的状态。释放该 scope 时关闭流并移除缓存状态。新会话选项填入 `conversation.hero.options`，worktree 卡片填入 `conversation.input.dock`。worktree 卡片显示正在进行的创建，有消息在等待时“取消”调用 `stopCreation`；或显示消息等待时失败或被停止的那次尝试，“重试”调用 `retryWorktree`，“不使用工作树”调用 `cancelWorktree`。标签页用 Remote 宿主信息中的宿主主目录缩短路径，每次传输重置后重新读取。标签页把自己是否可见报告给标题栏按钮的按下状态。标题栏按钮收起停靠的标签页，或关闭其浮动标签页。toast 位于 `shell.overlay` 条目中，因此比标签页存在得更久。只要 `sidebar.session.row.trailing` 中的会话行图标或 `sidebar.session.row.hover` 中的悬浮卡片部分有一个已挂载，就由同一条变更请求状态流供给它们；两者都从会话列表的摘要值中读取 Session 的 worktree 与绑定。变更请求卡片接收变更请求、它的快照与可选操作，其他界面可以复用。变更视图是 `forge-changes` 资源标签页类型：它的地址 `dsh-resource://forge-changes/<session>/local` 与 `dsh-resource://forge-changes/<session>/change/<url>` 指明来源，导航参数可以指定要滚动到的文件。标签页类型启用 `keepMounted`，将访问过的正文及其所属 Session 引用保留至标签页记录结束。它的 keyed panel hook 仅为可见正文订阅；其他面板界面仍可能保持共享 Session 流开启。它的正文用 slot store 按标签页保存范围与布局选择，经 Remote 读取，并用共享的代码高亮器高亮各行；标签页标题显示变更图标与视图名称。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `forgePanel` Remote 与按 Session 的面板 |
| [`src/panel.ts`](src/panel.ts) | 面板状态、检查调度与登录检查 |
| [`src/worktree.ts`](src/worktree.ts) | worktree 记录、投影、等待中的消息，以及在第一步创建 worktree |
| [`src/states.ts`](src/states.ts) | 会话列表用的变更请求状态 |
| [`src/git.ts`](src/git.ts) | 按 Session 权限执行 Git 查询 |
| [`src/parse.ts`](src/parse.ts) | Git 输出解析与远端顺序 |
| [`src/diff.ts`](src/diff.ts) | 补丁解析、把未跟踪文件表示为新增，以及 numstat 记录 |
| [`src/local-diff.ts`](src/local-diff.ts) | 分叉点、本地范围、新版本文本与 `branch` 范围摘要 |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 挂载、slot 条目与操作结果映射 |
| [`src/client/ChangeRequestCard.tsx`](src/client/ChangeRequestCard.tsx) | 可复用的变更请求卡片 |
| [`src/client/LocalChangesCard.tsx`](src/client/LocalChangesCard.tsx) | 本地变更卡片 |
| [`src/client/ChangesTab.tsx`](src/client/ChangesTab.tsx) | 变更视图 |
| [`src/client/DiffFile.tsx`](src/client/DiffFile.tsx) | 变更视图中的一个文件 |
| [`src/client/FileLabel.tsx`](src/client/FileLabel.tsx) | 变更文件的标签：文件名在前，目录在后 |
| [`src/client/WorktreeToggle.tsx`](src/client/WorktreeToggle.tsx) | 新会话的工作树选项 |
| [`src/client/WorktreeProgress.tsx`](src/client/WorktreeProgress.tsx) | worktree 创建卡片与 worktree 缺失卡片 |
| [`src/client/SessionRowForge.tsx`](src/client/SessionRowForge.tsx) | 会话行图标 |
| [`src/client/SessionHoverForge.tsx`](src/client/SessionHoverForge.tsx) | 会话行悬浮卡片中的部分 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Forge 子系统](../../../docs/subsystems/forge.zh.md)——变更请求类型与服务参考。
- [Session 绑定](../forge-session/README.zh.md)——变更请求如何绑定到 Session。
- [Worktree 服务](../worktree/README.zh.md)——worktree 如何创建并进入。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由工作目录服务与 Session 的对话：关于 Session 新 worktree 的通知会加入第一次请求的消息，“在项目目录继续”会为下一次请求排入同类通知，“创建变更请求”会发送一条请 Agent 创建变更请求的用户消息。“添加到输入框”提供以 `## User Comment N` 开头的冻结引用，包含 File、Side、Lines、Source、diff hunk 与 Comment；PR 引用还包含评审的提交。只有发送主输入框后，这些引用才进入正常记录的用户消息。检查、状态、恢复、会话列表与 GitHub 评审提交不会增加模型上下文。

#### KV Cache 影响

新 worktree 的通知没有影响，因为它属于 Session 的第一次请求，那时还没有任何缓存前缀。“在项目目录继续”之后的通知、“创建变更请求”发送的消息与发送后的评审引用都追加在缓存前缀之后。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **过滤文件与子模块** — 本地 diff 绕过 clean/process filter；Git 内置的换行、ident 与编码转换仍然生效。已物化的 LFS 文件及其他过滤文件可能显示为变更，即使普通 Git 认为它们未变；仅保留指针的检出可正常比较。面板不请求下载 LFS 对象。过滤器覆盖依赖 Git 2.31 或更新版本；旧 Git 可能忽略覆盖，按 Session 权限运行辅助程序。枚举与 diff 之间新增的驱动不在覆盖范围内。子模块提交变化仍可见，内部未提交修改不显示。
- **只在显示时轮询**——只有会话列表的某一行或该 Session 的活动面板界面订阅时才会轮询状态，保活但隐藏的变更正文不订阅；其间检查结束不会有通知。
- **会话列表中未打开的 Session**——会话列表从缓存的摘要中读取未加载 Session 的 worktree 与绑定：没有缓存摘要的 Session 两者都不显示；此版本之前最后使用的 Session 要打开之后才显示其 worktree。
- **检查触发时机**——检出只在 Session 的工具结果与目录变化之后检查；Session 之外的改动要等到刷新或下一个工具结果才会出现。
- **保留检出**——面板只在 Session 的第一步之前创建 worktree，不删除已有的检出目录或分支；失败或被取消的尝试可能留下分支或检出。分支名取自 Session id 与随机数字，而不是 Session 标题，因为那时标题还不存在。
- **一轮进行中的消息**——Agent 正在运行一轮或其他维护任务时进入的消息不会被暂留：所请求的 worktree 改为在第一步创建，失败时这一轮结束且不带这条消息；已删除的 worktree 不会被检查，工作目录服务会把 Session 移回项目目录。
- **等待中的消息**——消息等待期间，Agent 以空闲状态处于维护任务中，输入框不提供停止；只有卡片上的操作、Agent 的取消或 Remote 的停止能放行它，等待 Agent 空闲的调用方也会一并等待。
- **恢复**——恢复会从分支重新检出；分支也已删除时，从它开始时的提交重新创建。从未提交的修改随被删除的目录一起丢失。[worktree 服务](../worktree/README.zh.md#use-this-package)校验记录的目标，只移除该目标缺失且未锁定的登记。已有或未恢复完成的目录仍会阻止恢复；请先保存其中的文件并移除目录再重试，或在源项目继续。
- **链接 worktree 项目**——项目本身是链接 worktree 时该选项不可用：在 workspace-write 下它的 Git 目录位于可写根之外，新分支与之后的提交都无法写入。
- **变更范围**——待办：单个提交与上一轮的范围。“分支”范围需要一个默认分支与 HEAD 有共同历史的远端，或 Session 创建的 worktree。
- **大型变更**——本地补丁超过 `maxDiffBytes` 时不显示任何文件；超过托管平台或其提供方大小上限的变更请求 diff 不显示任何文件，只提供“在浏览器中查看”。不自动换行时，左右对比会在栏边截断长行。
- **代码审查页**——待办：在左侧导航中新增一个页面，列出用户在所选提供方上的变更请求；[决策笔记](../../../.agents/notes/implemented/feature/2026-10-09-forge-panel.zh.md)记录了它的接入位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
