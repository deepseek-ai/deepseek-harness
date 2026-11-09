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
- **归档清理**——归档一个会话后，由[工作树服务](../worktree/README.zh.md)回收它创建的干净且无人引用的工作树，无论来自新会话选项还是模型的 `create_worktree` 工具，分支及其提交保留。清理排队后，归档提示为“已归档，工作树将被清理”；最终保留时恢复为普通归档提示，失败时替换为警告而会话仍保持归档。撤销归档会取消尚未获准的删除，或等待已获准的删除结束；已移除的工作树使用现有的“恢复工作树”流程。插件页上该套件的 worktree 行提供“归档时不删除工作树”开关：保存后，归档会保留所有工作树并显示普通归档提示；开关在每次归档时读取，不影响已排队的清理。
- **创建卡片**——创建 worktree 期间，输入框上方的卡片显示新分支以及“创建分支”“检出文件”两个步骤；“更多详情”会列出分支与基准。“取消”停止这次尝试。尝试被停止或失败后，消息继续等待，失败时卡片显示原因：“重试”换一个新分支名再试；“不使用工作树”撤回请求，消息在当前检出中继续发送。
- **工作树已被删除**——Session 所在的 worktree 在 Session 之外被删除后，输入框上方的卡片会说明这一点；此期间发送的消息会等待、不开始这一轮，直到该 worktree 被恢复或离开，卡片也会说明消息之后会接着发送。“恢复工作树”（标签页中的“恢复”与之相同）在原目录重新检出该分支；分支也已删除时，从它开始时的提交重新创建分支；恢复期间卡片显示“准备工作树”“检出文件”两个步骤，标签页中的“恢复”变为加载状态。“在项目目录继续”把 Session 移回源检出。此期间标签页顶部一行显示警示图标。
- **代码审查和变更**——右侧栏起始页中的入口，与会话标题栏按钮打开同一个变更请求标签页。
- **标题栏按钮**——Session 有已绑定的变更请求、或其目录位于 Git 检出中时出现，用来显示或隐藏标签页。打开状态的变更请求存在检查失败、被要求修改或冲突时，按钮带红点。
- **会话列表**——Session 在面板为它创建的 worktree 中工作时，会话行的时间之后显示分支图标；另有一个图标显示它最需要关注的变更请求的状态，依次为需要处理、打开、草稿、尚未轮询、已合并、已关闭。打开中的变更请求图标保持会话行的浅色，head 分支端点填充为检查进行中、已通过或失败对应的颜色；已合并与已关闭的保留各自的状态颜色。会话行的悬浮卡片写出 worktree 分支及其起点，再列出最多三个变更请求的编号、标题、状态与检查，并说明还有多少个。重启后，下次轮询之前显示重启前已知的状态。
- **标签页**——顶部一行显示当前检出的分支（分离 HEAD 时为缩写提交），项目目录前显示目录图标、worktree 前显示分支图标，并说明检出的类型（Session 创建的 worktree 及其基准、其他 worktree 或项目目录）；它的提示给出路径，宿主主目录缩写为 `~`，旁边的按钮复制完整路径；worktree 已被删除时提供“恢复”。其下每张变更请求卡片显示状态图标、标题（点击在浏览器中打开）与编号；图标区分打开、草稿、已合并与已关闭，打开中的变更请求（草稿除外）检查失败、被要求修改或有冲突时显示为“需要处理”，与标题栏按钮的红点一致。卡片右上角还提供“在浏览器中打开”“复制变更请求链接”与“从本会话移除”，移除后的 toast 提供“撤销”。已取消的检查单独计数；列出的检查没有失败项时，折叠卡片显示取消数量。折叠的卡片还显示打开的变更请求的检查，以及被要求修改、冲突、草稿中最需要注意的一项；已合并或已关闭的则显示结束时间。展开的卡片显示源分支与目标分支，下面每项一行：打开的变更请求依次是检查（点击该行弹出检查列表，失败的排在前面，带耗时与链接）、评审结论与未解决讨论数（提供方只统计了部分讨论时数字后带 `+`）、合并状态，已合并或已关闭的显示结束时间；最后是按所选界面语言格式化的变更行数，点击该行打开变更视图。打开中的草稿还提供“标记为可评审”；主机现在就会合并的变更请求提供“合并”，其菜单列出仓库允许的合并方式并选中用户常用的一种，打开时固定卡片显示的 head。“确认合并”使用这个 head；轮询发现 head 变化后禁用确认，需重新检查并打开菜单。每次操作的结果都以 toast 报告；该 head 之后有新提交时不会合并。恰好有一个已绑定的变更请求处于打开状态时，它的卡片默认展开。刷新会重新检查检出与登录状态，并立即再次轮询每个变更请求；检查与登录状态确认结束前，刷新图标持续旋转。缺少登录时，横幅显示 `gh auth login` 命令。
- **本地变更卡片**——`branch` 范围有文件变更时始终显示，不受已关联变更请求影响。变更请求列表上方的卡片显示比较的基准（例如 `HEAD → origin/main`，始终是下文的默认基准）以及新增、删除行数与文件数，点击打开变更视图；展开的文件列表像变更视图一样标出各个文件，点击某个文件时，变更视图定位到该文件。识别出代码托管仓库、且没有以当前检出分支为源分支的打开中变更请求（含草稿）时，卡片提供“创建变更请求”：它以界面语言向 Session 发送一条用户消息，请 Agent 为这些变更创建变更请求，并以 toast 报告是否已发送。
- **变更视图**——展开的变更请求卡片上的“变更”一行与本地变更卡片会打开一个右侧边栏标签页，列出所有变更的文件。本地标签页名为“本地变更”，默认显示“分支”：工作树与未跟踪文件相对于分叉点的变更。它的标题栏写出当前检出的分支（分离 HEAD 时为缩写提交）与基准分支；点击基准分支打开可搜索的菜单：最前面是“默认”，即 Session 创建的 worktree 的基准提交，否则是 HEAD 与代码托管远端默认分支的合并基准；其后依次是远程跟踪分支与本地分支，各按最近提交排序，不含当前检出的分支，不在所创建的 worktree 中时也不含“默认”已经指向的远程跟踪分支。输入文字会立即筛选已列出的行，短暂停顿后列出名称包含该文字（不区分大小写）的分支；按 Enter 选择第一行。选择其他分支后，与 HEAD 和该分支的合并基准比较。标签页切换到其他范围时仍保留这个选择；关闭标签页或重新加载应用后回到“默认”。所选分支已不存在时，它的名称显示删除线；它与 HEAD 没有共同历史时，视图同样给出说明；两种情况都提供“使用默认基准分支”而不是“重试”。视图较窄时，先隐藏“包含未提交的修改”，再隐藏当前分支。“未提交”与 HEAD 比较，“未暂存”与暂存区比较，“已暂存”比较暂存区与 HEAD。变更请求的视图显示托管平台在其 head 处的 diff；当前检出分支就是该变更请求的源分支时，还会说明本地分支比该 head 多出几个提交。工具栏可以跳到某个文件、汇总变更行数、刷新，并在左右对比与单栏对比、自动换行与截断长行之间切换。访问过的变更标签页会在切换标签页与 Session、隐藏侧边栏及调整停靠位置时保持挂载，在 diff 未改变时保留文件折叠、大文件展开、上下文展开、布局与滚动位置。隐藏的变更视图释放面板订阅并推迟 diff 读取；返回时仅在最新 head 或本地摘要不同时重新读取。刷新替换 diff 后会丢弃展开的上下文，内容变化也可能移动阅读位置。视图隐藏时关闭临时菜单。关闭标签页或重新加载应用后不保留这些进度。每个文件是一张独立的卡片，带浅色底的标题在滚动时停在顶部。文件名在前，目录在后，用更小的浅色字显示，空间不够时目录先缩短；悬停时显示完整路径，重命名的文件显示新旧两条路径。每个文件带有新文件、已删除、重命名的标记（重命名标记写出原文件名，只换了目录时写出原路径），“分支”范围下的未跟踪文件还标“未提交”；文件菜单可以复制路径，本地变更可在侧边栏打开整个文件，变更请求可在浏览器中查看该文件在 head 处的页面。标题变窄时，路径、标记和“有新改动”会缩短，行数、“已审阅”和文件菜单始终完整显示。hunk 之间未变更的行折叠成一行，点击后从文件的新版本展开：工作树、“已暂存”时为暂存区，或经托管平台读取的 head 提交；读取 diff 之后文件又有修改时不会展开，直到视图重新读取。二进制文件与超过 `maxDiffBytes` 的未跟踪文件只显示一条说明；hunk 超过 1,000 行的文件先显示为一条写出变更行数的折叠条，点击后才绘制；前面的文件累计变更超过 5,000 行后，其后的文件默认收起。刷新与页面刷新快捷键、每次导航、变更请求的 head 变化，以及“分支”范围的摘要变化时，视图都会重新读取；变更请求的视图会先等到给出 head 的状态再读取，除非没有提供方服务它或那次轮询失败。head 已越过最新状态时，视图保持加载，等到比读取开始时更新的状态后按其 head 重新读取；该状态在读取期间已到达时立即重读。重新读取已显示的变更时，刷新图标会旋转。托管平台或其提供方因超过大小上限拒绝给出 diff 的变更请求（例如 GitHub 上输出超过提供方 `maxOutputBytes` 的 diff）显示“变更太大，无法在这里显示”并提供“在浏览器中查看”；其他读取失败提供“重试”，变更请求还提供“在浏览器中查看”。变更请求的 diff 在缓存期间对每个 head 提交与目标分支只下载一次，因此在同一 head 下重新打开、刷新与导航都不会再从托管平台读取。

- **分层、测试文件、已审阅与提交**——文件树上方的分层透镜保留全部文件，或“接口”“实现”“测试”中一层的文件，并显示各自的数量；不显示文件树时，工具栏以菜单提供透镜。仓库的声明优先：根目录 `.gitattributes` 把文件设为 `dsh-review-layer=test`、`interface` 或 `implementation` 时，文件属于对应的层；标为 `linguist-generated` 的文件属于“测试”。其次是可选的 `testPaths` 与 `interfacePaths`，它们追加在内置规则之前，默认为空。最后是按常见约定写的内置规则：Jest、Vitest、`go test`、pytest、RSpec、XCTest 与 .NET 的测试目录和文件、快照、本地化目录与 lockfile 属于“测试”；包清单、类型声明、头文件、类型存根与 Protocol Buffers、GraphQL、OpenAPI 等接口定义属于“接口”。其余文件属于“实现”。例如在 `.gitattributes` 中写 `*_test.go dsh-review-layer=test` 或 `api/**/*.yaml dsh-review-layer=interface`，即可记录仓库自己的约定。“隐藏测试文件”让文件树与 diff 都不显示“测试”层，也不列出被隐藏的文件，同时停用“测试”透镜。文件标题上的“已审阅”把该文件的这次改动标为已审阅并折叠它；工具栏显示已显示文件中已审阅的数量，按 `V` 标记或取消当前阅读的文件：焦点或文本光标所在的文件，否则是视图顶部的文件。改动与标记时不同的文件显示“有新改动”并重新展开。标记按 Session、变更来源、路径与改动摘要保存在本浏览器中，关闭标签页或重新加载后仍在；同一 Session 的多个标签页共用这些标记：在一个标签页中标记，其他标签页随之更新，且不会覆盖它们的标记。只改文件模式（例如 `chmod +x`）也算新改动。“提交评审”左侧，以及“分支”范围中基准分支右侧的“全部提交”按从旧到新列出提交，读取一次后保留到 head、本地分支或基准变化或刷新为止；单击只看一个提交，按住 Shift 单击看从上次单击的提交到这个提交的连续多个提交，这些提交必须依次是后一个的第一父提交：离开这条链的范围（例如跨越已合并分支的范围）会让菜单保持打开并说明原因；此时视图显示这些提交的改动，在最后一个提交读取未变更的行，提供“添加到输入框”，但不提供 GitHub 评论或评审。“分支”的提交不含未提交与未跟踪的文件。换基准分支或范围后回到全部提交；所选提交已不存在或不再是一条链时提供“查看全部提交”。
- **评审讨论**——变更请求视图会叠加代码托管平台在所显示 head 处读到的评审讨论。行级讨论显示在它最后一行所在的行之后，位于写下时所在的那一侧；若该行折叠在未变更的行中，则显示在折叠行之后。讨论标明写下时的位置，每条评论显示头像、作者、时间和 Markdown 正文（不显示原始 HTML），并用标签标出变更请求作者、机器人账号，以及当前登录用户尚未提交的评审中的评论。已解决的讨论折叠成一行，可以展开。针对整个文件的讨论显示在文件开头；被后续提交改到而过期的讨论集中在文件的行之后，显示写下时那段 hunk 的末尾，并提供“查看当时的文件”，读取写下讨论时那个提交上的文件并标出相应的行。选择了部分提交时，只显示行号对应最后一个所选提交的新版本侧讨论。文件树和每个文件标题都显示未解决讨论数。每点击一次文件标题上的计数，就按文件中的显示顺序跳到该文件的下一条未解决讨论（所选提交中没有的讨论排在最后），到最后一条后回到第一条；工具栏的“讨论”按钮打开讨论列表。列表按文件树顺序分组，组内讨论的顺序与文件中相同，可显示未解决、已解决或全部讨论，默认显示未解决的讨论；点击讨论会跳到它的位置，若所选提交中没有该讨论，会先切换到全部提交。视图宽度不小于 1,040px 时列表停靠在文件旁；更窄时浮在文件之上，并在跳到讨论前先关闭；窄于 480px 时占满文件区的宽度。读取被截断时，列表会注明。讨论上提供“添加到输入框”（把整个讨论作为引用插入）、“在 GitHub 中查看”，以及当前登录用户可以执行的写操作。没有待提交评审时，回复框立即回复，其下拉菜单可以带着这条回复开始待提交评审；有待提交评审时，回复框把回复加入其中，因为 GitHub 会把用户的每条回复都加入待提交评审。“解决讨论”和“取消解决”切换讨论状态；用户自己评论的菜单可以编辑或删除该评论，删除前会先确认，删除讨论中唯一的评论会一并删除讨论，确认时会说明这一点。用户正在讨论中写回复或编辑评论时，即使讨论已被解决，也保持展开。代码托管平台拒绝写操作时保留输入的文字并说明原因；结果不明时会重新读取讨论，并请用户核对后再重试。每次写操作后都会重新读取讨论，因为解决讨论不会改变 GitHub pull request 的更新时间。视图显示期间，每收到一次状态就重新读取讨论；点击刷新后，即使面板还保留着之前的读取结果，也会从代码托管平台重新读取；读取失败时保留上次的讨论并提供重试，提供方不支持读取讨论时不显示讨论。

检查行先显示轮询预览。不完整时，卡片使用托管平台的总体状态而不显示失败总数，并注明已加载的检查数量尚不完整。打开列表后，经 `changeRequestChecks` 单独读取该 PR 的后续页，时限独立于轮询。读取失败时保留预览并提供重试。关闭列表、head 变化或组件卸载会取消读取，忽略迟到结果；重新打开会读取当前详情。Remote 要求 URL 是该 Session 可见的绑定，并拒绝 head 提交不一致的响应。

diff 按文件树的深度优先顺序排列：同层目录在前、文件在后，各组按显示名称以区分大小写的 UTF-16 码元顺序排序。压缩目录链作为一个完整名称参与比较。筛选或折叠文件树不会改变 diff 的顺序。点击 diff 内容区可将焦点移入。左右方向键按 diff 顺序跳到上一个、下一个文件并展开它；到达首尾时停留。上下方向键保留原有滚动行为。手动滚动后，文件跳转从视口顶部的文件继续。文本编辑、非折叠文本选区、组合键、菜单与文件树控件保留各自的键盘行为。

`gitCommand`、`gitTimeoutMs`、`graceMs`、`maxOutputBytes`、`readinessTimeoutMs`、`maxBranches`、`worktreePrefix`、`maxDiffBytes`、`maxUntrackedFiles`、`maxCachedDiffBytes`、`maxCachedReviewBytes`、`reviewRefreshMs`、`maxCommits`、`testPaths` 与 `interfacePaths` 列在[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-client-ui-forge)中。

“全部文件”打开可搜索的目录树，并把选中文件滚动到中间；只有一个子目录的路径会合并显示，重命名文件也可以按旧路径搜索。较宽的变更面板会在 diff 旁显示同一棵树，工具栏的“文件树”按钮按“左侧 → 右侧 → 隐藏”循环切换，默认显示在左侧。按钮的无障碍名称说明下一步操作，移动或隐藏文件树时焦点仍留在按钮上。移动或隐藏文件树，以及切换标签页与 Session 时保留搜索、折叠状态、选中文件和宽度。拖动分隔线，或聚焦分隔线后使用方向键，可以调整文件树宽度。文件与文件夹预留相同的展开箭头列，子项相对父目录向内缩进。本地变更与每个 PR 保留独立标签页。划选代码文字或通过行号选择同一已显示 hunk、同一侧的连续行，文字划选与复制都限定在起始侧。点击“＋”打开纯文本评论框。使用鼠标时，悬停在某一行上也会在其行号旁显示“＋”，行号仍可点击：两栏时显示在悬停的一侧，单栏时显示在该行所属的一侧；按下即选中这一行，拖动可在同一侧扩展范围，松开即打开评论框。评论框支持换行和输入法组合输入，只有点击操作按钮才提交。可拖动底边调整高度。“添加到输入框”将评论作为可移除的引用加入主输入框，引用显示文件名、侧与行号以及评论，悬停时显示文件路径；多条引用只会在用户发送主输入框时一起发送。读到评审讨论且用户可以评审时，GitHub 分段按钮会用这条评论在 GitHub 上开始用户的待提交评审，或把评论加入其中；评论随后显示为带“待提交”标签的讨论，提交评审之前只有用户自己能看到。下拉菜单可以立即发布单条评论；用户有待提交评审时 GitHub 会拒绝单条评论，因此这时没有该菜单。Agent 引用和已发布的评论保留在对应代码旁。“请求更改”需要填写评审总结，弹窗在总结输入框旁说明此要求，并在切换评审决定时播报。PR 标题栏中的“提交评审”打开居中弹窗，只显示待提交数量、总结以及“评论”“批准”“请求更改”选项。有待提交评审时提交该评审，结果不明的提交与直接提交一样，在用户到 GitHub 核对之前阻止再次提交；“丢弃评审”在确认后删除该评审及其中的评论；没有待提交评审时，把总结作为一次评审发布。在用户自己的 PR 上，GitHub 只允许作者评论，因此“批准”和“请求更改”不可用。新建和删除文件只显示有内容的一侧行号。总结、评审决定，以及 Agent 引用与已发布评论的记录按 Session 和页签保存在当前浏览器，包括最初评审的 head。切换 Session 或隐藏面板时保留；关闭页签会清空它们，重新打开从空总结开始。待提交评审、已发布到 GitHub 的评论与已加入主输入框的引用不受影响。早期版本保存在此浏览器中的评论草稿保留在对应代码旁，带“浏览器草稿”标签，可以编辑、删除或加入待提交评审；存在待提交评审时，它们会让“提交评审”保持不可用；没有待提交评审时，“提交评审”把它们连同总结一起发布。head 变化后需要重新选择评论行。代码变化后的记录保留在文件末尾；文件已不在 diff 中时，记录显示在 diff 之后。页签保持打开时，结果不明的提交在重新加载后仍会阻止重复发送，直到用户检查 GitHub 并明确允许再次提交。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`ForgePanelController` 为每个被关注的 Session 保留一个 `SessionPanel`，最后一个关注方离开时销毁它。面板从 Session 的工作目录与绑定开始，在每个 `working-directory/change`、`tool/result` 与 `sandbox/mode` 事件之后重新检查，只在状态与已发布的不同时发布新的 `ForgePanelState`，所以检查结果与原来相同时不会通知任何关注方。每个变更请求在后续轮询失败时保留最近一次轮询得到的快照。并行 Git 读取失败时会取消并等待同批读取结束。检查一次只运行一个，最多再追加一次；Session 已离开的目录的结果会被丢弃。代码托管平台按远端顺序识别：先是上游所在的远端，然后是 `origin`，最后是其余远端。检查发现提供方识别的远端上有上游分支时，面板调用 `ctx.forgeSession.discoverBranch` 绑定该分支打开状态的变更请求；同一远端与分支在刷新前只查找一次。识别出的托管平台变化时以及刷新时，会在 `readinessTimeoutMs` 内检查登录状态；一次刷新在它触发的检查与登录状态检查结束后完成，轮询结果之后才到达。

检查运行 `rev-parse --show-toplevel`、`rev-parse --path-format=absolute --git-common-dir`、`rev-parse --path-format=absolute --git-dir`、`symbolic-ref --short HEAD`、`rev-parse --short HEAD`、`rev-parse --abbrev-ref @{upstream}` 与 `remote -v`；`branches` 运行 `symbolic-ref` 与 `for-each-ref --count=<maxBranches>`；`diffBases` 像下文的 `localDiff` 一样找出默认分叉点，在 `maxDiffBytes` 以内对 `refs/heads/` 与 `refs/remotes/` 运行 `for-each-ref --sort=-committerdate`，排除 `origin/HEAD` 等符号引用，每类最多保留 `maxBranches` 个名称包含查询文字的分支。之后，检查会为本地变更卡片统计 `branch` 范围的规模：找出分叉点，对它运行 `diff --numstat -z -M`，采用与下文 `localDiff` 相同的辅助程序和子模块限制，并列出未跟踪文件。每个命令都使用 Session 解析出的沙箱模式：`read-only` 与 `workspace-write` 需要沙箱，`danger-full-access` 无需沙箱后端。命令禁用可选的索引写入、钩子、文件系统监视器、提示与对象的延迟获取，移除继承的 Git 选择器与携带密钥的变量，并各自受 `gitTimeoutMs` 时限与每个输出流的 `maxOutputBytes` 上限约束。Git 打印的顶层目录、Git 目录与公共 Git 目录经 `ctx.fs` 解析为工作目录服务记录的规范进程路径；Git 目录与公共 Git 目录不同的检出是链接 worktree。工作树选项在 `danger-full-access` 沙箱模式下可用，在 `read-only` 下不可用，在 `workspace-write` 下只有两个目录都位于 Session 沙箱策略的规范工作区根内时才可用。

worktree 请求是一条 `plugin:client-ui-forge/worktree` 记录，由 `forgeWorktree` 投影折叠：请求与撤回在第一个 `turn/start` 或创建之前生效；在第一个 `step/start` 之前，未完成请求的第一条 `created` 记录生效。该投影还从 Session 头部与每个 `working-directory/change` 记录 Session 的目录；它的客户端视图随 Session 摘要下发，在该目录就是所创建的 worktree 或位于其下时为该 worktree，否则为 null。一轮开始或 worktree 已创建之后，`requestWorktree` 以 `forgePanel/session-started` 拒绝；没有 `worktrees` 服务时以 `forgePanel/worktrees-unavailable` 拒绝；分支名为空时以 `forgePanel/invalid-branch` 拒绝；`cancelWorktree` 只以第一种拒绝，也不需要 `worktrees` 服务；两者都会忘掉失败的尝试。消息进入有未完成请求的 Session 的收件箱时，一个 `agent/inbox/inserted` 监听器在这次投递唤醒 Agent 之前启动 Session 所属 Agent 的维护任务，因此 Agent 会暂存唤醒，等这次暂留结束后才开始这条消息的这一轮。暂留使用新分支名进行一次尝试，在面板状态中发布正在进行的阶段，设置 `held`，`waiting` 为 `creation`，并记录带源仓库根目录的 `created`。尝试失败（其分支、基准、失败步骤与原因以 `failure` 留在面板状态中）或经 `stopCreation` 停止后，暂留继续等待：`retryWorktree` 再做一次尝试，没有消息等待或已有尝试进行时以 `forgePanel/not-waiting` 拒绝；撤回请求则让消息在当前检出中继续。Agent 空闲且 Session 在所创建 worktree 中工作时，进入的每条消息都会启动一次暂留，检查该 worktree 是否缺失；缺失期间暂留以 `waiting` 为 `restoration` 等待，`restoreWorktree` 或 `continueInProject` 在暂留内运行，之后放行消息；检查无法给出结果时立即放行。Agent 的取消与 Remote 的停止都会结束暂留；Agent 正在运行一轮或其他维护任务时进入的消息不会被暂留。worktree 服务把工作目录通知排进队列，由第一步认领。一个 `agent/pre-step` 监听器在请求仍未完成的 Session 的第 1 步创建 worktree，覆盖没有被暂留的消息；它把通知移入本步提议的消息，失败时这一轮结束、请求保留。没有消息等待时，`restoreWorktree` 与 `continueInProject` 以各自的维护任务运行；`restoreWorktree` 以 `restoration` 发布正在进行的步骤，并在结束恢复的同一状态中清除 `missing`。套件把它的 `worktrees` 服务隔离，因此同时启用 Git Worktrees 时会有两个互不影响的服务。`track` 以 `forgePanel/unrecognized-url` 拒绝没有提供方识别的 URL。`markReady` 与 `merge` 只作用于该 Session 中由提供方服务的可见绑定，否则以 `forgePanel/not-bound` 拒绝；`merge` 带上卡片显示的 head 提交，head 已变化时以 `forgePanel/stale-head` 拒绝，其他拒绝都是带主机原因的 `forgePanel/action-failed`。


恢复在修改前记录 `restoring`，仅在成功后记录 `restored`。投影版本 3 在重载后保留未完成的恢复。目录存在本身不能放行等待的消息：检出根目录与公共 Git 目录必须匹配记录的工作树。插件卸载会取消并等待所有创建、恢复与消息等待任务，然后释放面板读取器和投影。

每次检查还会判断 worktree 是否缺失：Session 的目录位于所创建的 worktree 内，`ctx.fs.lstat` 在那里找不到目录，再由源仓库中的 `show-ref` 判断分支是否还在。

Session 在所创建的 worktree 中工作时，`localDiff` 以它的 `baseCommit` 为分叉点；否则按代码托管远端的顺序，对每个远端依次运行 `symbolic-ref --quiet --short refs/remotes/<remote>/HEAD` 与 `merge-base HEAD` 找出分叉点；找不到时 `branch` 范围以 `forgePanel/no-fork-point` 拒绝。`branch` 范围指定了 `refs/heads/` 或 `refs/remotes/` 下的基准引用时，`show-ref --verify` 找到该引用后改用 `merge-base HEAD` 与它的结果；引用不存在时以 `forgePanel/base-missing` 拒绝，HEAD 与它没有共同历史时以 `forgePanel/no-fork-point` 拒绝；其他引用名在运行 Git 之前即被拒绝。它以固定的 `a/`、`b/` 前缀和 `core.quotePath=false` 运行 `diff --no-ext-diff --no-textconv --submodule=short --ignore-submodules=dirty --no-color -M`，分别与分叉点、HEAD（第一次提交之前为空树）、暂存区比较，或带 `--cached` 与 HEAD 比较。读取补丁与统计前会查询 Git 配置，应用命令级 clean/process filter 覆盖。配置读取失败或被截断时停止比较：`localDiff` 报告 `forgePanel/filter-config-failed`，修正 Git 配置或读取上限后可重试；统计失败时本地变更卡片保持隐藏。过滤器枚举在读取补丁时使用 `maxDiffBytes` 上限，统计时使用 `maxOutputBytes` 上限。未跟踪文件由 `ls-files --others --exclude-standard -z` 列出，最多 `maxUntrackedFiles` 个，其余计为未列出；它们经 `ctx.fs` 读取并作为新文件加入，前 8,000 字节含 NUL 字节或不是 UTF-8 时视为二进制。补丁、文件列表或文件超过 `maxDiffBytes` 时以 `forgePanel/diff-too-large` 拒绝，目录不在检出中时以 `forgePanel/not-a-checkout` 拒绝。宿主用 jsdiff 把补丁解析为文件与 hunk，浏览器不会收到原始补丁。Host 为每个文件计算由路径、状态、hunk 以及 `old mode` 与 `new mode` 行组成的摘要（二进制改动加上 blob 名，未跟踪的二进制文件加上内容），并先按根目录 `.gitattributes` 中的 `dsh-review-layer` 与 `linguist-generated` 行确定分层（后面的行覆盖前面的行，不是层名的值视为未指定；模式按 [`src/wildmatch.ts`](src/wildmatch.ts) 中 Git 的 wildmatch 规则匹配，取反模式与 Git 一样跳过），再用 picomatch（包含点文件）依次匹配 `testPaths`、`interfacePaths` 与 [`src/layers.ts`](src/layers.ts) 中的内置规则。`.gitattributes` 的读取来源：“已暂存”读暂存区，其他本地范围读工作树，所选提交读最后一个提交，变更请求经 `fileText` 读 head 或最后一个所选提交，文件不存在时按没有处理。`localCommits` 用 `log --no-show-signature --topo-order --reverse` 列出分叉点到 HEAD 之间最新的 `maxCommits` 个提交，因此列表以 HEAD 的提交结尾。带所选提交的“分支”范围比较第一个提交的第一个父提交（根提交用空树）与最后一个提交；不是完整对象名、不在列表中或顺序颠倒的提交以 `forgePanel/commits-missing` 拒绝，第一父提交不是列表中前一个提交的所选提交以 `forgePanel/commits-not-linear` 拒绝；`localText` 经 `show` 读取那个最后的提交。`localText` 读取一个文件的新版本：“已暂存”经 `show :<path>` 从暂存区读取，其余经 `ctx.fs` 读取；离开检出的路径会被拒绝。`changeRequestDiff` 与 `changeRequestText` 只作用于该 Session 中由提供方服务的可见绑定，否则以 `forgePanel/not-bound` 拒绝；它们经提供方的 `diff` 与 `fileText` 读取绑定最新状态中的 head 提交，补丁与它的 `.gitattributes` 同时读取，补丁读取失败时取消 `.gitattributes` 的读取，两者都结束后才给出结果，补丁的失败优先于 `.gitattributes` 的失败，`too-large` 失败以 `forgePanel/diff-too-large` 拒绝，`stale` 失败（head 已越过该状态）以 `forgePanel/stale-head` 拒绝，尚未读到状态或托管平台以其他原因拒绝时以 `forgePanel/diff-failed` 拒绝。`stale` 的 diff 会立即重新轮询该变更请求（每个 head 提交一次）且不缓存，因此不会有补丁被存放在它不描述的 head 下。Host 保留 `changeRequestDiff` 读到的补丁及其属性，每个变更请求一份，按 head 提交与目标分支区分，总量超过 `maxCachedDiffBytes` 时丢弃最久未读的；之后在同一 head 与目标分支下的读取不论来自哪个 Session 都从内存返回，读取失败的结果不保留。`changeRequestCommits` 返回提供方 `commits` 的列表，提供方不读取提交时返回 null；带所选提交的 `changeRequestDiff` 在该列表中找到它们，按与“分支”范围相同的规则拒绝，并从第一个提交的父提交到最后一个提交读取 `compare`，不缓存。本地分支比 head 多出的提交数由 `symbolic-ref`、`cat-file -e` 与 `rev-list --count` 得出；当前检出分支不是源分支、本地没有 head 提交或 Git 失败时为 null。`changeRequestReview` 同样只作用于可见的绑定；head 与最新状态的 head 不同时，读取前就以 `forgePanel/stale-head` 拒绝；随后调用提供方的 `readReview`，把 `stale` 映射为 `forgePanel/stale-head`、`unsupported` 映射为 `forgePanel/review-unsupported`、其余失败映射为 `forgePanel/review-failed`。每个变更请求保留一次读取结果，以 head 提交和更新时间为键；保留的结果按 JSON 计超过 `maxCachedReviewBytes` 时，最久未读的先被丢弃；保留时间达到 `reviewRefreshMs` 后，或读者刷新视图时，重新读取，因为解决 GitHub 讨论不会改变更新时间。

`changeRequestStates` 为会话列表推送调用方可读的、已列出的 Session 所绑定的每个变更请求的最近编号、标题、状态、草稿标记、检查汇总、评审结论与可合并性：先是一个 `baseline` 帧，之后是 `changed` 帧。所有流共用一次运行。初始化之前和帧之间均响应取消；最后一条流结束及插件卸载会等待初始化与已接受的写入完成，再关闭本次运行的存储域。后续运行会等待该域关闭后重新打开，并读取已存状态。列举期间收到的绑定更新优先于初始快照。它经 `sessionQuery` 列出 Session 而不加载它们，已加载 Session 的可见绑定取自 `ctx.forgeSession`，其他 Session 的取自缓存的 `forgeChangeRequests` 摘要；它跟随已加载 Session 的绑定变化，并经 `ctx.forge.watch` 订阅每个已绑定的变更请求；已关闭的按空闲间隔轮询，已合并的保留订阅以接收显式刷新结果。每个变化了的状态以其 URL 的 SHA-256 摘要为键存入 `forge_panel_change_requests` 存储域，仅在所有已列出 Session 的绑定均已知时删除无人绑定的已存状态；写入失败时记录日志，状态仍保留在内存中。宿主缺少 Session 查询、投影缓存、存储或 Session 存储服务时，流以失败结束。

浏览器入口先挂载 Remote，再挂载界面。每个 Session 一条流，同时供给标签页、标题栏按钮、新会话选项与创建卡片；第一个订阅方出现时打开，最后一个离开时关闭，传输重置后重新打开，在 Session scope 保留期间保存最后的状态。释放该 scope 时关闭流并移除缓存状态。新会话选项填入 `conversation.hero.options`，worktree 卡片填入 `conversation.input.dock`。worktree 卡片显示正在进行的创建，有消息在等待时“取消”调用 `stopCreation`；或显示消息等待时失败或被停止的那次尝试，“重试”调用 `retryWorktree`，“不使用工作树”调用 `cancelWorktree`。标签页用 Remote 宿主信息中的宿主主目录缩短路径，每次传输重置后重新读取。标签页把自己是否可见报告给标题栏按钮的按下状态。标题栏按钮收起停靠的标签页，或关闭其浮动标签页。toast 位于 `shell.overlay` 条目中，因此比标签页存在得更久。只要 `sidebar.session.row.trailing` 中的会话行图标或 `sidebar.session.row.hover` 中的悬浮卡片部分有一个已挂载，就由同一条变更请求状态流供给它们；两者都从会话列表的摘要值中读取 Session 的 worktree 与绑定。变更请求卡片接收变更请求、它的快照与可选操作，其他界面可以复用。变更视图是 `forge-changes` 资源标签页类型：它的地址 `dsh-resource://forge-changes/<session>/local` 与 `dsh-resource://forge-changes/<session>/change/<url>` 指明来源，导航参数可以指定要滚动到的文件。标签页类型启用 `keepMounted`，将访问过的正文及其所属 Session 引用保留至标签页记录结束。它的 keyed panel hook 仅为可见正文订阅；其他面板界面仍可能保持共享 Session 流开启。它的正文用 slot store 按标签页保存范围、基准分支、所选提交、透镜、测试文件开关与布局选择，按 Session 把已审阅标记保存在 `localStorage` 的 `dsh.forge-viewed.v1.<Session>` 下（每个 Session 最多 20 个来源，最多 50 个 Session），经 Remote 读取，并且传给每个文件段的值（包括标签页可见性）在多次渲染之间保持同一标识，所以一次渲染只重绘值有变化的文件段，可见性变化时重绘全部文件段。展开的文件在它的段第一次进入滚动区域 1200px 范围内，或跳转到它的某个评审讨论时，才绘制各行，并在同一次渲染中用共享的代码高亮器高亮，此后一直保留；在此之前按每个绘制行 22px 占位；标签页标题显示变更图标与视图名称。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `forgePanel` Remote 与按 Session 的面板 |
| [`src/panel.ts`](src/panel.ts) | 面板状态、检查调度与登录检查 |
| [`src/worktree.ts`](src/worktree.ts) | worktree 记录、投影、等待中的消息，以及在第一步创建 worktree |
| [`src/states.ts`](src/states.ts) | 会话列表用的变更请求状态 |
| [`src/git.ts`](src/git.ts) | 按 Session 权限执行 Git 查询 |
| [`src/parse.ts`](src/parse.ts) | Git 输出解析与远端顺序 |
| [`src/diff.ts`](src/diff.ts) | 补丁解析、把未跟踪文件表示为新增，以及 numstat 记录 |
| [`src/local-diff.ts`](src/local-diff.ts) | 分叉点、本地范围、分支提交、新版本文本与 `branch` 范围摘要 |
| [`src/layers.ts`](src/layers.ts) | 按路径 glob 与 `linguist-generated` 属性分层 |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 挂载、slot 条目与操作结果映射 |
| [`src/client/ChangeRequestCard.tsx`](src/client/ChangeRequestCard.tsx) | 可复用的变更请求卡片 |
| [`src/client/LocalChangesCard.tsx`](src/client/LocalChangesCard.tsx) | 本地变更卡片 |
| [`src/client/ChangesTab.tsx`](src/client/ChangesTab.tsx) | 变更视图 |
| [`src/client/BaseMenu.tsx`](src/client/BaseMenu.tsx) | “分支”范围的基准分支菜单 |
| [`src/client/DiffFile.tsx`](src/client/DiffFile.tsx) | 变更视图中的一个文件 |
| [`src/client/section-reach.ts`](src/client/section-reach.ts) | 文件段何时绘制各行 |
| [`src/client/ReviewControls.tsx`](src/client/ReviewControls.tsx) | 分层透镜、测试文件开关与已审阅进度 |
| [`src/client/CommitMenu.tsx`](src/client/CommitMenu.tsx) | 提交选择器 |
| [`src/client/viewed-files.ts`](src/client/viewed-files.ts) | 保存在浏览器中的已审阅标记 |
| [`src/client/ReviewThreads.tsx`](src/client/ReviewThreads.tsx) | 评审讨论卡片与已过期区域 |
| [`src/client/ThreadList.tsx`](src/client/ThreadList.tsx) | 讨论列表 |
| [`src/client/review-threads.ts`](src/client/review-threads.ts) | 讨论位置、列表筛选、hunk 摘录与讨论引用 |
| [`src/client/thread-state.ts`](src/client/thread-state.ts) | 读取讨论并确定它们在所显示变更中的位置 |
| [`src/review-cache.ts`](src/review-cache.ts) | 保存在内存中的评审讨论 |
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

间接影响，经由工作目录服务与 Session 的对话：关于 Session 新 worktree 的通知会加入第一次请求的消息，“在项目目录继续”会为下一次请求排入同类通知，“创建变更请求”会发送一条请 Agent 创建变更请求的用户消息。“添加到输入框”提供以 `## User Comment N` 开头的冻结引用，包含 File、Side、Lines、Source、diff hunk 与 Comment；PR 引用还包含评审的提交，本地“分支”引用还包含视图比较的基准，来自所选提交的引用还会注明这些提交。只有发送主输入框后，这些引用才进入正常记录的用户消息。检查、状态、恢复、会话列表与 GitHub 评审提交不会增加模型上下文。对评审讨论使用“添加到输入框”时，会加入一段固定的 `## Review Thread N` 引用，包含 File、Side、Lines、这些行号所在的提交、State、Source、记录下的 diff hunk，以及逐行引用的每条评论的作者、时间和正文。

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
- **变更范围**——待办：上一轮的范围。“分支”范围的“默认”需要一个默认分支与 HEAD 有共同历史的远端，或 Session 创建的 worktree；否则必须选择基准分支。
- **分支极多**——基准分支菜单在筛选前读取全部引用，这样搜索才能找到任意分支。引用超过 `maxDiffBytes`（默认约 165,000 个）或列出时间超过 `gitTimeoutMs` 时，菜单提示无法读取分支；“默认”仍可使用。
- **大型变更**——本地补丁超过 `maxDiffBytes` 时不显示任何文件；超过托管平台或其提供方大小上限的变更请求 diff 不显示任何文件，只提供“在浏览器中查看”。不自动换行时，左右对比会在栏边截断长行。
- **尚未绘制的文件**——读者滚动到展开的文件附近之前，它按每个绘制行 22 px 占位，没有计入左右对比的配对、自动换行、未变更行按钮和评审卡片，所以文件绘制时滚动范围会略有变化；它已保存的评审评论也要等它绘制后才显示。
- **长 diff 中的页内查找**——展开的文件要等读者滚动到附近才绘制各行，所以浏览器的页内查找在更靠后的文件绘制之前匹配不到它们的行；要在整个 diff 中查找，需要视图自己的查找控件。
- **代码托管平台上的已审阅状态**——变更请求的已审阅标记只保存在本浏览器中，在提供方评审接口完成之前，不读取也不写入 GitHub 的已审阅状态（`markFileAsViewed`）；换浏览器或设备后没有这些标记。
- **评审讨论的写入**——在一个变更视图中的写操作，会在该变更请求的其他已打开视图收到下一次状态时显示；解决讨论不会改变 pull request 的更新时间，要等到 `reviewRefreshMs` 之后才显示。GitHub 每个用户在每个 pull request 上只保留一个待提交评审。早期版本保存在浏览器中的评论草稿，只有其文件和行仍与所显示的 diff 一致时才能加入待提交评审，否则只能编辑或删除。对所选提交的评论只能添加到输入框。被折叠隐藏的评论与其他评论显示方式相同；头像由浏览器从代码托管平台的图片服务器加载。
- **分层**——内置规则只覆盖常见约定，其他约定由仓库写在 `.gitattributes` 中；按路径无法识别 Rust 的内联 `#[cfg(test)]` 模块，也无法判断一种语言导出了哪些声明，“接口”层保留整个文件，找出变更的导出需要语言分析器，可由之后的透镜扩展点提供。`linguist-generated` 只读取根目录的 `.gitattributes`，不读子目录中的 `.gitattributes`，也不展开属性宏。
- **所选提交**——变更请求最多列出提供方的 `maxCommits` 个提交（GitHub 为最早的 250 个），“分支”范围则列出最新的 `maxCommits` 个；范围必须沿第一父提交相连，因此已合并分支的提交只能逐个查看，不能与本分支的提交一起查看；每次查看提交范围都从托管平台读取；所选提交上的评论只能添加到输入框，因为 GitHub 评审针对 head。
- **代码审查页**——待办：在左侧导航中新增一个页面，列出用户在所选提供方上的变更请求；[决策笔记](../../../.agents/notes/implemented/feature/2026-10-09-forge-panel.zh.md)记录了它的接入位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
