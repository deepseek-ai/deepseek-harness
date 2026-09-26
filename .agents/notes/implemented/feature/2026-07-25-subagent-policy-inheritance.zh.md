# Agent Note: 进程内 subagent 策略继承——子 agent 在父级的沙箱覆盖项下启动

Status: implemented

[English](2026-07-25-subagent-policy-inheritance.md) | 中文

## 问题

Auto 或 Full access 预设身份以及沙箱与审批覆盖项都是按会话的日志折叠。进程内 subagent 会获得一个新会话，因此 spawn 子 agent（智能体）过去会回退到部署默认值，fork 子 agent 则只能看到其已完成轮次前缀中的切换。因此，委派可能放宽已经切换到 `read-only` 的父级，或在 Auto 与 Full access 共用同一旋钮组合时静默保留陈旧身份。

## 决策

委派边界会在第一次 await 之前调用共享的子 agent 辅助函数（`dsh-subagent` 中的 `captureDelegatedPolicyOverrides`／`appendDelegatedPolicyOverrides`）；一次性驱动器与[可继续启动](../../../../packages/subagent/subagent/README.zh.md)都会使用它们。当 `permissionPresets.current(parent.session)` 为 `auto` 或 `danger-full-access` 时，捕获会复制当前 `permission/preset` 身份，同时对 `sandboxPolicy.overrideOf(parent.session)` 获取快照，并把子 agent 的审批策略钉定为 `'never'`。父级后续的切换属于父级的未来；取消后重新委派会取得新快照。权限预设与沙箱策略服务都是可选的：只复制 Auto 或 Full access 身份与显式沙箱会话覆盖项，绝不复制部署默认值或一次性授权。审批策略不继承——[审批钉定决策](2026-08-10-subagent-approval-pinned-never.zh.md)取代了本 note 原先的审批覆盖项继承。

继承的 Auto 或 Full access 身份会成为一条 `permission/preset` 事件，捕获的沙箱值与钉定的审批值则会在子 agent 工厂的未发布设置阶段成为带来源标记的 `sandbox/mode` 与 `approval/policy` 事件。会话构造函数已把 `Session.firstLiveSeq` 固定在 constructor seed 之后，而 `Session.inheritedEventCount` 保留精确的 fork 前缀长度，因此继承事实会排在 fork 历史之后，却不改变其谱系 cut。生命周期本地遥测从 `firstLiveSeq` 开始，因此排除 constructor seed，并包含这些未发布设置事件。因此，既有的末事件胜出折叠会让委派快照压过陈旧的 fork 历史，并让子 agent 后续的切换压过该快照。孙代 agent 会折叠其父级已记录的状态，因此无需另一套继承机制即可组合此规则。

Auto review 不会把这条继承的 preset 事件变成授权回执。每次 child 调用仍会重新分类：普通项目内工作为低风险并直接允许；中风险工作必须在 child 创建 prompt 或已核验的 human／直接父级消息中得到点名动作、准确目标和范围的明确授权，且不存在未解决冲突；高风险工作始终拒绝。`parentSession`、创建 prompt 与既有 `agent-message.senderSessionId` 足以在 one-shot、continuable 与 cold resume 路径中恢复这份上下文；不会新增父 call id、解析后的任务 metadata、委派记录、review receipt 或 Session format migration。

普通的会话追加会在发布前校验继承事件，持久化层则在会话公布时捕获完整的未发布日志。因此，任何已物化的子 agent 日志都会在首批数据中存下继承事件；不存在第二套策略存储、schema 字段或查询索引。`source: 'delegation'` 标记让审批叙述能够区分继承与子 agent 侧的用户切换。

### 被拦住的子 agent 会经历什么

受限子 agent 会得到普通拒绝标记，升级请求则被子 agent 钉定的 `'never'` 策略确定性拒绝；`subagent:delegation` 运行时上下文声明告知子 agent 上报限制而不是重试，由控制器持有的父 agent 可以放宽自己的会话后重新委派（[审批钉定决策](2026-08-10-subagent-approval-pinned-never.zh.md)）。

[Auto review 决策](2026-08-28-auto-review.zh.md)为共享 Auto／Full access 旋钮组合扩展此继承规则；本文仍拥有委派时权限捕获的决策。

## 考虑过的替代方案

- **通用的 `SessionHeader` 策略字段**：不予采纳。它们会在元数据中复制一项事件溯源事实，并要求贯穿核心会话类型、持久化后端、查询索引、碰撞标识与每个策略消费方进行传播。未发布设置阶段的事件具备所需顺序，并复用现有持久化存储。
- **将新策略事实与构造历史合并**：不予采纳，因为这会把 child 拥有的委派策略归类为继承历史，并模糊 child 快照压过陈旧 fork 值所依赖的生命周期顺序。未发布设置让历史与新事实留在构造边界各自原有的一侧，无需再增加会话选项；遥测会捕获 child 自有的一侧。
- **首个提示词监听器**：不予采纳。尽管创建事务已经允许在发布前追加日志，它仍会引入监听器顺序与更晚的时序边界。
- **复制部署默认值**：不予采纳。默认值仍由运维人员拥有且可能变化；未切换的父级不会记录任何值，因此其子 agent 跟随当前部署。
- **每次调用时沿 `parentSession` 实时解析**：不予采纳。这会打破「两个会话永远看不到彼此状态」的隔离不变量，要求父会话在子 agent 的整个生命周期内保持加载，还会让父级在子 agent 运行途中做的切换追溯性地改变一个正在运行的子 agent。委派时快照才是本设计的语义：子 agent 保持它被交付时的策略；取消后重新 spawn 即可拿到收紧后的策略。
- **强制使用 `'never'`**：本 note 当初不作为继承行为采纳，理由是强制值会排除未来的子 agent 应答器；该结论已被[审批钉定决策](2026-08-10-subagent-approval-pinned-never.zh.md)推翻，现行理由归其所有。把 ask 路由到根控制器需要父链所有权与发起 spawn 的 `callId`，仍按[审批 seam Agent Note](2026-07-06-approval-seam.zh.md) 所述延期。

## 后果

- spawn、fork 和嵌套的进程内子 agent 会在父级选中 Auto 时保留其身份，保留父级显式的沙箱覆盖项，并被钉定为 `'never'` 审批。聚焦测试套件证明 Auto 身份、真实文件系统拒绝、陈旧 fork 优先级、委派时捕获、实时事件边界、默认值省略与上下文释放。
- 在 Auto 下，这些 child 仍会为每次调用重新获得 low／medium／high 决定。human 指令在中风险动作上优先于直接父级任务调整，而且两种来源都不能授权高风险动作。
- 无密钥 headless 快照是组装后应用层面的回归测试：只有父级是 `read-only`，部署默认值是 `workspace-write`；若移除捕获，子 agent 的持久化事件与被拒的磁盘写入这两项检查都会失败。
- 每次委派最多增加三条仅日志事件。权限预设、沙箱策略与审批这三项服务的可选 peer 类型由 `dsh-subagent` 拥有——其共享辅助函数持有 `ctx.get` 消费；未组合这些服务的组合保持原有行为。进程外子 agent 仍采用自身的部署策略，正在运行的子 agent 不跟随父级后续切换。
