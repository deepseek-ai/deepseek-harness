# Agent Note: 被委派的 subagent 以钉定为 `'never'` 的审批策略运行

Status: implemented
Archived: 2026-09-30

[English](2026-08-10-subagent-approval-pinned-never.md) | 中文

## 问题

被委派的子 agent 发起审批请求时无人可问。在交互式父级（`'ask'`）之下，后台子 agent 的升级请求会变成一个任何产品界面都不展示的挂起问题——subagent 会话不进入 Web 侧边栏，父级的 `list_agents` 只报告普通的 `running`／`idle`，目录树的行也只显示活动状态——因此被权限拦住的子 agent 与正常干活的子 agent 无法区分；headless 与无应答者的组合则让同一次 ask 以 `'unavailable'` 失败关闭。拒绝的审计记录只落在子 agent 自己的日志里，而且没有任何工具参数或 Web 控件能调整一个正在运行的子会话的沙箱模式或审批策略（Issue #1723）。机制繁重的修复方案——持久化的受阻状态投影、父级通知、目录树徽标，以及穿过 subagent 所有权围栏的权限写入路径——在临近发布时代价不成比例。

## 决策

被委派的子 agent 只在委派时固定的权限范围内行动，审批提示则从它的世界中彻底移除：`captureDelegatedPolicyOverrides(parent)`（`dsh-subagent/src/child-agent.ts`）仍对父会话的显式沙箱覆盖项建立快照，但只要审批能力已组合，就把 `approvalPolicy: 'never'` 钉定下来——不再读取父级自身的审批策略。`appendDelegatedPolicyOverrides()` 把这个钉定作为持久化的 `approval/policy { policy: 'never', source: 'delegation' }` 事件写入子 agent 的日志，与沙箱快照走完全相同的一次性与可继续委派路径，因此冷恢复会重放它，fork 种子中陈旧的父级策略也会输给它。

强制执行沿用既有的 `ApprovalService` `'never'` 语义，落在裁决 ask 的唯一操作上：子 agent 的每次 ask——bash 或 fs 的 `sandbox_permissions` 升级、hook 驱动的权限询问、任何未来的请求方——都在咨询任何应答者之前确定性地解析为 `'rejected'`，同时仍在子日志上留下 `approval/asked`／`approval/decided` 审计对。子 agent 的全部权限故事因此就是它的沙箱范围：`danger-full-access` 父级委派出的子 agent 无需任何审批，`read-only` 父级委派出的子 agent 没有任何逃生通道，而放宽的决定始终属于父级一侧（先放宽父会话，再重新委派或继续 follow-up）。

每个进程内子 agent 都被告知而非被困住：`applyChildComposition` 注册作用域内的 `subagent:delegation` 运行时上下文声明（order 120，位于 `sandbox:policy` 与 `approval:policy` 语句之后），声明权限范围已在启动时固定、需要审批的操作会被自动拒绝、需要更宽访问的任务应以上报限制收尾而不是重试。该声明是运行时上下文贡献而非系统提示词 section，因此部署的系统提示词在父子之间保持统一（快照测试套件钉住了这一统一性），该事实也随策略语句乘坐同一份持久化快照。

本决策取代[进程内委派策略决策](2026-07-25-subagent-policy-inheritance.zh.md)中的审批一半，并推翻其「强制 `'never'` 会排除未来的子 agent 应答器」的结论：审批继承已经落地，产生的正是上述不可见的受阻状态；未来若要引入子 agent 应答器，必须先推翻本 note。

## 考虑过的替代方案

- **继承父级的审批覆盖项**（先前的行为）：不予采纳。只有已处于 `'never'` 的父级才产生确定性的子 agent；交互式父级种出的子 agent，其 ask 要么等待一个无人在看的提示，要么以 `'unavailable'` 失败关闭，结果取决于当时恰好接入了哪些界面。
- **受阻状态可见性与逐子级权限调整**（#1723 原有的验收）：延后而非否决。`list_agents` 的受阻标注、经由结算投递 seam 的父级通知、目录树徽标，以及 subagent 专用的权限通道仍是更完整的设计，但每一项都需要独立的 seam 工作；一旦子 agent 不可能进入等待审批的受阻状态，这些都不再是必需。
- **把子 agent 的 ask 路由到父控制器**：仍按[审批 seam Agent Note](2026-07-06-approval-seam.zh.md) 延后。它需要父链所有权与发起 spawn 的 `callId`。
- **在 `ApprovalService` 内按会话来源钉定**：不予采纳。这会让审批包耦合委派词汇，并重复一个委派边界已经拥有的决定；委派种入的事件之所以可强制执行，是因为当前不存在任何能切换子会话策略的写入路径（`/permission` 命令要求通用 Host 路由，而 subagent 所有权围栏对子会话拒绝该路由）。

## 后果

- 子 agent 的沙箱继承就是委派权限模型的全部；`DelegatedPolicyOverrides.approvalPolicy` 字段收窄为 `'never' | undefined`（仅在未组合审批能力时为 `undefined`）。
- 模型可见：每个子 agent 的运行时上下文快照携带 `subagent:delegation` 声明以及固定的审批已禁用语句；父级请求不变。executor 边界测试证明：即使根部有一个本会批准的应答者，子 agent 的升级仍被拒绝且不咨询该应答者，审计对照常落日志。
- 边界：进程内一次性、可继续以及 workflow 派生的子 agent 都经由共享辅助函数强制执行；`subagent-acp` 子 agent 保留该提供方显式的机器 `permission` 策略；`claude-code`、`codex` 与 `dsh-sdk` 子 agent 运行在外部进程中，由各自的组合决定。
- 在钉定之前持久化的子 agent 冷恢复时折叠到部署审批默认值；处于预发布阶段，不添加迁移。
- 快照夹具记录了该钉定：每个进程内子日志都新增委派 `approval/policy` 事件，`subagent-published-run-failure` 现在会持久化一份单事件子日志，而此前该子 agent 不留任何持久化事件。
