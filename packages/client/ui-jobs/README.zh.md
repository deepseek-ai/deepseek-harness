---
description: "会话面板的「后台任务」分栏：可展开的流式输出面板、位于已折叠的已结束列表上方的进行中行，以及无保留输出的已结束任务的静态行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

## 概述

`dsh-client-ui-jobs` 在会话面板的「后台任务」分栏中展示本会话的后台任务，包括生命周期、耗时、进度与终态详情。进行中的任务和保留了输出的已结束任务提供可展开的输出面板；收起即停流。进行中的行在标签下方展示类型、当前进度与持续更新的时长。已结束的行折叠在计数之下；没有保留输出的任务保持静态，包括回答已交给模型的 subagent。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 web-app 清单加载本插件。它在 order 300 注册[会话面板](../ui-session-panel/README.zh.md#contribute-a-section)分栏 `background-jobs`，位于「子智能体」之后，标题为「后台任务」。任务运行中且面板未显示时，面板开关上的蓝点（`conversation.session.panel.indicator`）会提示这一状态，并向辅助技术说明数量；开关挂载期间它保持该会话的任务列表订阅。在会话看得到至少一个 job 之前，该分栏不渲染任何东西，面板因此连同标题一起隐藏它，普通对话不会为未使用的能力显示分栏。

进行中的行排在最前，最近开始的在前；已结束的行按结束时间从新到旧排在「已结束 {count}」切换按钮之下，箭头紧跟文字，旁边有「清空」操作。有进行中的任务时默认折叠，否则默认展开；用户的选择在 Session 内保持，隐藏后再次显示面板也不变。两个分组各自只显示五行，然后以会话面板的收起控件作为最后一行：「显示其余 {count} 个运行中」或「显示其余 {count} 个已结束」，点击后显示其余的行并变为「收起」；只有能收起两行及以上时分组才收起。这个选择同样在 Session 内保持，「清空」会让已结束分组回到只显示五行。已展开的行被分组收起期间停止观察输出。每行只占 28px 一行：命令，行尾依次是时长、运行时的停止按钮和箭头，遵循会话面板的列；点整行（包括箭头）都能展开或收起。命令放不下时，指针停在这一行上会滚动显示全文；停止按钮悬停 500ms 后显示其操作说明。指针在行上停留 500ms 后，悬停卡片显示任务类型、状态或结束详情以及时长，但不显示命令：命令可能有很多行，展开输出面板后可查看全文并复制；指针停在停止按钮上时不显示悬停卡片；辅助技术把任务类型和状态作为该行的描述读出。以非 0 退出码结束的任务显示警告色圆点，与被停止的任务相同；`failed` 的任务显示错误色圆点。有任务进行中时已结束列表折叠，只剩已结束任务时展开；按下切换按钮会覆盖该默认状态。「清空」在本客户端中隐藏当前已结束的行，Session 保持打开期间一直有效，隐藏后再次显示面板也不变；注册表保留其记录，之后结束的 job 照常出现，没有剩余行时分栏隐藏。

按下可观察的行会展开其输出面板，再次按下则收起；同一时间只展开一行。每个时长都带工具提示：进行中的行为「已运行 {duration}」，已结束的行为「耗时 {duration}」；有任务进行中时，进行中的时长每秒更新一次。

### 一 job 一行

`ctx.jobs` 镜像的 `job.list` 流是唯一名册：每个 `JobView` 行携带生命周期、时长、实时 `progress` 行或终态 `detail`，以及其保留字节数——进行中的 job，或留有保留输出的已结束 job，就是行可展开的依据。不存在需要 join 的第二份名册。

运行中的 job 行还带一个两击式停止控件，其提示只写「停止任务」，不带命令：首击武装并将其展宽为「确认停止」按钮，三秒内的确认击调用 `ctx.jobs.kill`，行状态经名册流收敛（先 `stopping`，再入已结束列表，其 detail 携带 `cancelled by the user`）。kill 被拒绝时显示「停止失败」四秒。该 kill 不在模型的播报台账里认领任何东西，任务的 owner agent 因此照常收到标准完成通知——模型被明确告知用户停止了它的任务，而不是留给它去猜（[参考](../../jobs/tool-jobs/README.zh.md)）。

### 展开的面板

展开可观察的行会从 `ctx.jobs`（由 `dsh-api-job-controller` 安装）打开该 job 的输出观测流，注入内嵌终端面板。面板复制的是命令（不是输出），命令与输出行完整换行，输出在固定高度内滚动而非折叠，且不绘制自己的运行状态点——上方的行承载状态。保留缺口与流中断在面板上方渲染为提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

一条 `conversation.session.panel.section` 注册渲染分栏正文；会话面板绘制其标题、提供内边距并负责滚动。所有数据经 `ctx.jobs` 到达——组件不持有任何传输状态。名册跟随挂载：一个 `useEffect` 在分栏挂载期间（即会话面板显示期间）保持会话的 `job.list` 流打开。观测跟随可见性：另一个 `useEffect` 为展开行的 job 打开流，并在收起或卸载时关闭它，包括面板隐藏时。

| 文件 | 角色 |
|---|---|
| [`src/client/JobsSection.tsx`](src/client/JobsSection.tsx) | 分栏：进行中与已结束的行、时长、停止控件、输出面板 |
| [`src/client/jobs-store.ts`](src/client/jobs-store.ts) | 按 Session 保存已清空行的 store |
| [`src/client/index.ts`](src/client/index.ts) | 会话面板分栏注册与词典 |
| [`src/client/locales.ts`](src/client/locales.ts) | `job` 命名空间文案（zh 为事实源） |

后台任务行使用[嵌套几何规则](../../../docs/ui-radius.zh.md#nested-hover)中的标准菜单项圆角；带底色运行行内的控件保留紧凑圆角。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-api-job-controller`](../../api/job-controller/README.zh.md) —— 行、面板与停止控件背后的 `job.list`、`job.follow` 流、`job.kill` Remote 与 `ctx.jobs` 服务。
- [`dsh-jobs`](../../jobs/jobs/README.zh.md) —— 拥有环与投影语义的注册表契约。
- [`dsh-client-ui-session-panel`](../ui-session-panel/README.zh.md) —— 为本分栏排序、绘制标题并负责滚动的会话面板。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 面板所配置的 `TerminalBlock` 表面。

-----

<a id="model-experience"></a>
## 模型体验

无。本包为人类渲染宿主观测到的状态与实时输出，不触碰任何提示词、消息、schema、流或工具结果。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV 缓存影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定当前包约束，不是任务清单。

- **不渲染 channel 标签**——stdout 与 stderr 块拼接为一条流；按 channel 着色是展示层的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

无。

</details>
