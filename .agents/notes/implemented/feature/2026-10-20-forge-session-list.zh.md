# Agent Note: 会话列表中的 forge 状态

Status: implemented

[English](2026-10-20-forge-session-list.md) | 中文

## Problem

[forge 面板](2026-10-09-forge-panel.zh.md)原先在 Session 标题旁的标签中写出 Session 的分支。标题栏的操作行不会收缩，因此较长的分支名会与后台任务标签等其他标题栏条目重叠。想知道哪些 Session 在自己的 worktree 中工作、它们的哪些变更请求需要处理，也必须逐个打开 Session 的标签页。会话列表为行图标与悬浮卡片提供了位置，即 `sidebar.session.row.trailing` 与 `sidebar.session.row.hover`，其中的条目不得加载或绑定 Session。一行需要两类事实：Session 日志记录的事实，即面板创建并进入的 worktree 以及 Session 绑定的变更请求；以及只有轮询才知道的事实，即每个变更请求的状态与检查。

## Decision

Session 标题旁的标签已移除，由标签页顶部一行写出分支。Session 在面板为它创建的 worktree 中工作时，会话行在时间之后显示分支图标；另有一个图标显示它最需要关注的变更请求，依次为需要处理、打开、草稿、尚未轮询、已合并、已关闭。打开中的变更请求图标保持会话行的浅色，并用圆点标出检查；已合并与已关闭的保留各自的状态颜色。会话行悬浮卡片中的部分写出 worktree 分支及其起点，再列出最多三个变更请求的状态与检查，并说明还有多少个。

日志事实经投影的客户端视图进入列表，由 Session 摘要携带。`forgeWorktree` 投影还从 Session 头部与每个 `working-directory/change` 记录 Session 的目录；该目录就是所创建的 worktree 或位于其下时，视图为该 worktree，否则为 null。`forgeChangeRequests` 视图列出绑定但不含状态，与[绑定决策](2026-10-09-session-change-request-bindings.zh.md)的设想一致。投影缓存为未加载的 Session 保留这两项。

轮询到的状态经 `forgePanel.changeRequestStates` 流进入列表。宿主用一次运行服务所有流，最后一条流结束时运行停止。它经 `sessionQuery` 列出 Session 而不加载它们，已加载 Session 的可见绑定取自 `ctx.forgeSession`，其他 Session 的取自缓存的摘要；它跟随已加载 Session 的绑定变化，并经共享的 `ctx.forge.watch` 订阅每个已绑定的变更请求；已关闭的按空闲间隔轮询，已合并的保留订阅以接收显式刷新结果。每个变化了的状态以其 URL 的 SHA-256 摘要为键存入 `forge_panel_change_requests` 存储域，因此重启后在下次轮询之前就能显示最近已知的状态；仅在所有已列出 Session 的绑定均已知时删除无人绑定的已存状态。每条流先发送调用方可读状态的 `baseline`，之后发送 `changed` 帧，均经 Remote 访问控制过滤。

浏览器为所有会话行与悬浮卡片部分只保留一个状态来源：第一个订阅方打开流，最后一个关闭它，传输重置后重新打开。

## Alternatives considered

**把变更请求只留给标签页。** forge 面板最初否决了 Session 行悬浮分区，因为对单个 Session 而言它与标签页重复。列表能同时比较所有 Session，这是任何标签页都做不到的；悬浮部分也只补充会话行图标所概括的事实。

**保留 Session 标题旁的分支。** 截断标签会遮住分支名，而且标题栏只显示当前打开的 Session；列表显示每个 Session，标签页则完整写出分支。

**把轮询状态放进投影。** 投影折叠的是 Session 日志，而轮询到的状态不写入日志。放进投影要么为每次轮询记录事件，而这些事件没有任何模型请求需要；要么让投影依赖重放无法重建的进程内状态。

**为每个已列出的 Session 跟随其面板。** 面板会在 Session 的执行环境中用 Git 检查检出并检查登录状态；列表只需要绑定与变更请求状态。

**加载已列出的 Session 来读取绑定。** 列表将重放每个 Session 的日志；缓存的摘要无需加载就能回答。

**只把状态保存在内存中。** 重启后每一行都会显示未知状态，直到每个变更请求再次被轮询。已存状态是派生数据，因此不符合 schema 的记录会被放到一边，而不是让运行失败。

**为在项目目录中工作的 Session 显示分支一行。** 读取该分支需要在 Session 的执行环境中运行 Git，而列表不加载 Session 就无法到达那里。

## Consequences

列表无需加载 Session 就能显示每个 Session 的 worktree 与变更请求状态，重启后立即显示最近已知的状态，标题栏也不再重叠。有会话行显示期间，已列出 Session 绑定的每个打开中的变更请求都会被轮询，因此有大量带打开变更请求的 Session 时，对代码托管平台的请求会增多；已关闭的继续按空闲间隔轮询，已合并的停止自动轮询。没有缓存摘要的 Session 要打开之后才会在列表中显示其 worktree 与变更请求；此变更之前最后使用的 Session 也要到那时才显示其 worktree，因为 `forgeWorktree` 的状态已变化，旧的缓存行会被丢弃。没有会话行显示期间结束的检查不会有通知。
