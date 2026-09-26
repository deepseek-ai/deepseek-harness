# Agent Note：归档仍有工作在跑的 Session

状态：implemented

[English](2026-09-21-archive-stops-running-session-work.md) | 中文

## 问题

归档原本是一次纯可见性写入：`WorkspaceRegistry.archiveSession` 把 id 加进注册表全局的归档集合，别的什么都不做。在回合中途被归档的 Session 会在看不见的地方继续跑——agent、它的工具子进程、它的模型请求一直跑到结束——而归档行刻意不画状态点，用户无从得知还有 agent 在消耗 token。后台子代理、所属任务或到期提醒同样可能继续工作，或在隐藏的 Session 里开启新回合。Web 面从不销毁 Agent，这种暴露会持续到宿主进程退出。

## 决策

归档绝不隐藏正在运行的工作。规则归注册表所有，并为此声明一个能力接缝：`workspace/session-activity`（waterfall）向提供方询问某 Session 还有什么在跑；`workspace/session-stop`（parallel）请它们停止。提供方像任何插件注册监听器一样注册在根上，因此 workspace 包不认识任何 agent、任务或提醒的词汇。`SessionActivityKindMap` 在 workspace 包里是空的：每个提供方从其两个面都导入的模块合并自己的族（Agent 注册表的 `turn`、`job`、`subagent`、`schedule`），渲染它们的消费方为其分支导入这些模块，遇到其他任何键时落到通用行。

- **默认拒绝。** `archiveSession(sessionId)` 对非空的活动答案以 `WorkspaceActiveSessionError` 拒绝；API 把它映射为 `workspace/session-active`，details 携带各族及各项的 id 与名称。没有要求停止工作的调用方绝不会把工作藏起来，无论它是哪个客户端或 SDK。
- **按请求停止，先写后停。** `archiveSession(sessionId, { stopActivity: true })` 跳过活动检查，先写入归档，再派发停止事件：pre-step 门禁读取的正是持久化的归档集合，因此停止所引发的每一次唤醒——被取消子代理的结算、排队的 follow-up——都已被拦下。停止请求只发出、从不等待收敛，因此 Remote 在每个提供方的请求发出后即返回，用户的行随即隐藏；停止失败只是一条 warn 日志，不是撤销归档的理由。
- **停止即用户的停止。** Agent 注册表用 `agent.cancel({ kind: 'user' })` 取消回合——与停止按钮同一条路径，因此被打断的工具调用以 `tool/result` 收口、回合以 `aborted` 结束，但不带按钮的 `keepInbox`，因此排队输入被丢弃并记录一次收件箱拼接。任务注册表接缝 kill 所属任务，由其构造函数只通过抽象的 `list` 与 `kill` 为每个实现安装。Subagent runtime 以父身份取消运行中的子代理子孙（持久化血缘、subagent 来源、任意深度、从不包括 fork）。每个请求各自兜住，一个抛错的子代理或任务不会让其余的继续跑。Schedule 插件在与工具相同的串行队列的一个槽位里删除该 Session 已存储的全部活动宿主任务（[归档准入读取已存储的任务](2026-09-22-archive-admission-reads-stored-tasks.zh.md)）。它读已存储的行，而不是对会话日志做 runtime fold，因为宿主任务比其 Session 的 Agent 活得更久，是到期提醒唯一能被看见的地方。每个提供方只拥有它本来就有的词汇：Agent 注册表认识回合，任务接缝认识任务，Subagent runtime 认识子代理，Schedule 插件认识提醒；API Session Controller 只保留已归档血缘的步骤门禁。没有新事件类型，也不在别的所有者的回合内写入，因此恢复后的 Session 从一份正常收尾的日志继续，取消归档不会带回任何被停止的东西。
- **已归档即不跑模型步。** API Session Controller 的 `agent/pre-step` 监听器拒绝为已归档 Session 或其子代理子孙提出的步骤，loop 以 `blocked` 收口且不发请求。这封住了迟到的唤醒投递——子代理结算、排队的 follow-up、在活动作答与写入之间开始的回合——跑出隐藏回合的窗口，也让无视 cancel 的子代理无法替一个谁也看不见的父级干活；取消归档即为整条血缘解除门禁。
- **拒绝即确认。** 侧栏先发普通归档；静止的 Session 一如既往无对话框直接归档。`workspace/session-active` 拒绝会打开"停止并归档"对话框，其清单来自宿主的答案而非客户端对运行状态的镜像，因此对话框列出的正是宿主将要停止的内容。确认后带 `stopActivity` 重发；提示提供撤销，撤销只恢复 Session，不会让被停止的工作继续。

## 考虑过的替代方案

**只拒绝，让用户逐项手动停止。** Reasonix 桌面端如此。它保住了归档的非破坏性，但已停止的 Session 若还有后台子代理在跑仍会被拒，用户得自己去追子代理、任务和提醒；提醒在 Web 上根本没有控件。确认对话框已经写明了破坏性，而这本是偏向拒绝的唯一理由。

**写入前等待收敛。** Codex 把等待限定在十秒然后继续；MiniMax 在回合锁超出预算仍存活时拒绝。两者都让用户的点击悬在最慢的那个取消上。这里的停止是廉价的同步请求，pre-step 门禁无论是否收敛都保证不跑隐藏模型步，清理失败也可接受，因此等待整个移出了请求路径。

**归档前在客户端停止。** OpenCode 在客户端隐藏且从不停止，它运行中的 Session 从列表消失而状态事件继续。客户端拥有的语义只覆盖一个客户端；注册表拥有的接缝覆盖每一个调用方。

**用客户端的活动镜像把归档动作置灰。** 那需要从列表投影自行推导运行中的回合、运行中的子代理、所属任务和活动提醒，且可能与宿主不一致（无主任务、没有宿主 Agent 的子代理）。一次被拒绝的往返就能拿到宿主自己的清单。

**让 workspace 或 schedule 包依赖 agent 注册表。** waterfall 与 parallel 事件让 Agent 注册表、任务注册表接缝、Subagent runtime 和 Schedule 插件无需向实体注册表新增依赖边就能提供各自的族；每一方都为事件类型新增了指向 `dsh-workspace` 的可选纯类型边，方向是自然的"特性依赖实体"（`dsh-workspace` 不依赖它们中的任何一个，因此不成环）。

**由 API Session Controller 报告各族。** 控制器看得到每个活 Agent、任务注册表和 Session header 上的血缘字段，本可以自己枚举回合、子代理和任务——但那样它就得认识每个 owner 的词汇（描述符与名称、父级原因的取消、任务归属）。Agent 注册表、任务接缝与 Subagent runtime 本来就拥有这些词汇，所以每一族都跟着自己的 owner；控制器只保留只读归档集合与 header 字段的血缘步骤门禁。门禁也不能反过来搬进 `dsh-workspace`：各 owner 现在依赖它的类型，workspace 包再依赖 Agent 的事件词汇就会成环。

**只由活着的 Session 报告 `schedule` 族。** 已存储的任务才是权威，且比其 Session 的 Agent 活得更久，因此以存活为条件会让存储行被武装的冷 Session 静默归档，其到期行随后投递进一个被门禁以 `blocked` 收口的回合，在没有模型步的情况下消耗掉这次触发（[归档准入读取已存储的任务](2026-09-22-archive-admission-reads-stored-tasks.zh.md)）。

## 后果

已归档的 Session 保证空闲：它要么本来就静止，要么其工作已按用户停止的方式停止，且在恢复之前不会为它跑任何一步。置顶与归档决策里的"归档无需确认"仅对静止 Session 成立；运行中的情形会先询问。停止的收敛是尽力而为：无视 kill 的任务或无视 cancel 的子代理会被记录，pre-step 门禁在此期间阻止该 Session 消耗模型请求。活动检查与归档写入是两步，其间开始的回合会被隐藏，pre-step 先于该写入的每一步连同其工具调用照常执行，直到写入之后的第一步被阻断。先写后停与门禁留下两处残余。在归档写入与 Schedule 插件的停止之间崩溃，会留下一个已存储任务仍被武装的已归档 Session；取消归档时它们再次出现，与从未请求过停止时一样；当这类行的目标时刻过去，Schedule runtime 会按自己的定时器选中它并自行 resolve 该 Session 的 Agent，一次性提醒于是把 follow-up 投递进一个被门禁以 `blocked` 收口的回合，该次触发因此在没有模型步的情况下被消耗，取消归档后也不会重放。准入本身会报告没有活 Agent 的 Session 的已存储任务，因此这类 Session 在残余发生之前就被拒绝。

为此决策调研的同行产品：Codex 与 Kimi Code 先停止再归档；Claude Code 通过让远端会话无法写入来停止；Reasonix 与 MiniMax 拒绝忙碌的 Session，MiniMax 在有界取消之后才拒绝；Pi 没有归档但在每次切换会话前 abort；OpenCode 既不拒绝也不停止。每一个会停止的产品都走自己的常规取消路径，以便日志正常收尾。
