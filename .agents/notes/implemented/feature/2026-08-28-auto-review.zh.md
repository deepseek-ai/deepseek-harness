# Agent Note: 每次工具调用前的实验性 Auto review

Status: implemented

[English](2026-08-28-auto-review.md) | 中文

## 问题

Full access 让有用的项目工作无需反复审批即可继续，但也允许破坏性操作与敏感信息外泄。把审批委托给模型的权限模式需要明确的权威策略、完整待执行动作描述，以及绝不执行被拒绝 body 的失败路径。共用 Full access 的执行旋钮也使独立持久模式身份成为必要，包括 child 继承较早 fork 前缀的情况。

## 决策

[`dsh-experimental-auto-review`](../../../../packages/experimental/auto-review/README.zh.md)是显式安装的实验性 Web 层，按[实验包发布决策](../process/2026-09-12-publish-all-experimental-packages.zh.md)参与发布。默认 Web 保持 Read Only、Workspace Write 与 Full access。此层贡献仅限当前会话的 `auto`，唯一持久身份为 `permission/preset:auto`；它使用 Full access 的 `danger-full-access` 沙箱与工具定义，审批策略由[用户审批兜底决策](2026-09-24-auto-review-user-approval-fallback.zh.md)决定。Headless、通用设置与新会话默认值都排除此 integration。

每个原生调用与已开始的 PTC `tools.*` inner call 都在 body 前接受一次审查。外层 `run_code` transport 与 PTC 程序内直接 Node 效果不在保证范围内。不提供按工具名豁免、缓存 grant、重试、可配置策略或第二授权检查；拒绝之后的行为由[用户审批兜底决策](2026-09-24-auto-review-user-approval-fallback.zh.md)负责。重复调用也重新审查。

### 效果与权威

固定策略遵循 allow／soft-deny／hard-deny 区分，按动作实际效果分类，不按名称或声称意图分类：

| 风险 | 示例 | 决定 |
| --- | --- | --- |
| `low` | 普通项目内读写、分析、format／lint／test／build、非破坏性 Git，以及保留调用能证明在本 Session 创建的对象的精确清理 | 允许 |
| `medium` | 不可逆删除既有状态、force push／历史改写、生产读写／部署、非敏感外部写入／发送，以及权限／安全／系统变更 | 只有当前 human 或直接父级明确授权动作、准确目标与必要范围时才允许 |
| `high` | 敏感数据跨越当前信任边界外泄及等价 hard-deny 效果 | 拒绝，包括显式请求的动作 |

实际效果不明确或超出已确立范围时按拒绝处理。后续指令只有明确撤销或替换旧指令才能消除冲突；直接父级指令不能覆盖 human 限制。历史可以证明对象由本会话创建，但不能授权 medium 操作或解除 high 禁令。

Reviewer 从既有 Session 事实派生权威。Shipped Web human 指令具有 `source.kind === 'user'` 和浏览器 prompt admission 写入的 `rpcId`。Child 初始直接父级 prompt 在其自身既有创建 descriptor 之后识别；后续 `agent-message` 只有 `senderSessionId` 与 `SessionHeader.parentSession` 匹配时才属于直接父级指令。Human 文本定义或替换任务与限制。直接父级文本在这些限制内定义 child 任务。项目指令只施加约束；checkpoint 恢复有损语境；图片、附件元数据和历史调用提供事实。Compaction 不会把 checkpoint 提升为已经离开 surface 的原文本所拥有的 human 权威。

### 一次完整 reviewer 请求

Integration 只使用最新 `request/header.config` 的 provider／model 与 shipped adapter 默认 reasoning。它既不比较冗余 route metadata，也不复制主 agent 请求。请求固定包含五个分区：

| 分区 | 保留输入 |
| --- | --- |
| `REVIEW_POLICY` | 固定分类、来源权威与严格结果规则；allow 后立即以 Full access 执行，没有后续确认 |
| `ENVIRONMENT` | 仅既有 Session header `cwd` |
| `PROJECT_INSTRUCTIONS` | 可见项目指令，保留原始来源并赋予约束角色 |
| `FILTERED_HISTORY` | 当前 compaction surface 中带来源的 human／直接父级消息、checkpoint、图片／附件事实，以及历史调用名称与日志参数 |
| `PENDING_ACTION` | 工具名称、描述、参数 schema 与解析后的 arguments |

reviewer 从 Session 的完整动作历史构建这两个动作分节：授权是符合 `REVIEW_POLICY` 来源规则的那个更早调用，而重复或冲突的身份必须在整份日志的任何位置都可见，而不是只在近期窗口内可见，因此 Session 投影与有界读取都无法支撑该判定。这次读取使用已废弃的同步 `snapshotEvents()`，并带有行级 `typescript/no-deprecated` 豁免。

主 agent 的 V3 `system/message` 节点、assistant 正文／reasoning 与 tool results 全部排除。当前调用必须属于 `step/start` 记录的开放 step；缺少 step 归属时拒绝执行。该调用只在 `PENDING_ACTION` 出现；尚未开始的 sibling 没有历史调用事实。原生 schema 来自最新 request header。PTC 在 binding 构造时捕获冻结 schema，经由调度器传入 `ToolExecution`；描述与参数 schema 不进入开始／结算事件或 Session／SDK wire。动作事实缺失、不一致或有歧义时拒绝调用，不查询 live registry。超窗请求直接拒绝，不做摘要、截断、额外 compaction 或设置小型输出 token 预算。

### 结果与取消

Reviewer 可以输出 reasoning blocks，随后恰好一个 JSON text block 和终态 `stop`。封闭对象只允许 `low + allow`、`medium + allow/deny` 与 `high + deny`；只有 deny 可携带字符串 `reason`。额外字段、重复成员、非法组合、其他 block 或终态以及 provider 失败都是 reviewer 失败，由[用户审批兜底决策](2026-09-24-auto-review-user-approval-fallback.zh.md)以具体错误报告。风险与 reviewer trace 不成为持久状态。

最终拒绝（[用户审批兜底决策](2026-09-24-auto-review-user-approval-fallback.zh.md)将其限定在 `never` 审批策略下）让原生结果与 PTC 结算事件携带同形结构化 `AutoReviewDeniedError`／`AUTO_REVIEW_DENIED` 及可选原始理由。对最终拒绝，主 agent 通过普通失败渲染只收到 `Auto review rejected tool "<name>"; its body was not executed`。PTC 保留既有程序异常／catch 行为；捕获拒绝不会将其提升为外层失败。通用 Web 工具卡片为折叠行提供拒绝身份，为展开行提供一行未执行输出，不提供输入正文。只有该显示过程会 trim、折叠行分隔符，或提供本地化空理由 fallback；持久化与两套 SDK 保留完整原始理由，不增加长度或脱敏规则。

准入与在途 review 登记在首次 await 前同步完成。Integration 拥有一个生命周期 controller 和一个在途操作集合。卸载先关闭新选择／review admission，经由既有 preset writer 把存活 Auto Session 切为 Full access，该 writer 写入 `never` 审批策略，不改变沙箱值、不关闭终端，然后中止并等待 review 结清，最后移除 listener 与 contribution。Provider 结算后，lifecycle abort 始终形成规范的 dispatch 前取消，包括晚到 allow、deny 或 failure。Caller 取消保留 ToolRuntime 优先级：晚到 allow 在 dispatch 前取消；晚到 failure 或最终拒绝保留原结果，`ask` 下晚到的拒绝产生已取消的审批与规范的 dispatch 前取消。被取消的 review 不启动工具 body。

完整 integration 缺失或失败时，持久 Auto Session 不能发布。日志不改写，也不后台重试。重装后用户可以重新打开它；已经迁移为 Full access 的存活 Session 保持原状，直到显式切换。

### 进程目录与 child

Permission owner 通过生成的 `permissionPresets` Remote 方法发布一份完整进程目录；BFF 显式挂载它，并转发无 payload 的失效事件。一个浏览器目录在读取前订阅，为两个选择器提供数据。Epoch 与 connection-generation 检查只发布胜出的完整结果。胜出读取失败或 connection reset 会清空旧快照；只有后续既有读取、通知或 reset 才重试。已 dispose 或陈旧的结算不能发布。每次目录失效都通过命令 owner 关闭 slash 选择器与待确认对话框，同时保留草稿，因此等待自身读取的选择器仍保留失败与重试状态；重新打开时加载当前目录。Session 投影只携带当前选择，因此目录安装或移除不写 Session 事件或序号。

Auto 带右上标 `EXP`。两个可见当前会话选择器都要求实验确认；显式 `/permission auto` 已构成同意。Composer 使用通用 Menu 既有 portal 定位保持在视口内，同时保留 218–360px 边界。Slash popup 保留 `min(220px, 100%)` 与 `max-width: 100%`，窄 composer 将 trigger 折叠时也一样。

[委派时权限捕获](2026-07-25-subagent-policy-inheritance.zh.md)在首次 await 前记录 Auto 或 Full access，并在 fork seed 与 sandbox／approval override 之后追加该既有 preset event。单次与可继续创建共用此规则；cold resume 只读取 child 日志。后续 parent 切换不改变该 child，后续 child 自己的切换仍可胜出。Read Only 与 Workspace Write 保留 sandbox 继承加 `approval: never`，因此可能保持 `custom`。Auto child 使用既有 lineage 与消息独立分类每次调用，不增加父 call metadata、委派记录、receipt、Header／descriptor 字段或 Session format。进程外 child 在父委派获准后保留自己的权限系统。

## 考虑过的替代方案

**默认或正式发布 integration** 会把实验模型审批策略带入每个部署。私有源码 Web patch 在复用既有插件安装器的同时保持显式 opt-in。

**新增 sandbox 或 approval-policy 值**会把 review 与执行耦合，产生没有当前消费者的组合。显式 preset 身份保留 Full access 未改变的执行行为。

**持久化 PTC schema 或重新读取 registry**要么为临时输入扩张持久 wire，要么审查与程序收到的 binding 不同的定义。Binding 已经拥有所需不可变快照。

**用 Session 事件表达目录变化**会把进程可用性归到 Session，并要求同序号重新发布。完整 Remote 读取加失效通知让每项事实保留在自己的 owner。

**可配置策略、豁免、grant 或另一个审批阶段**会削弱固定安全上限，或引入第二个决定生命周期。每个受支持调用一次 review 提供单一结果与取消 owner。

## 后果

Auto 增加模型延迟和 token 成本，并可能误判效果。Full access 执行与 PTC 程序限制使实验确认成为必要。过滤限制不可信指令角色，但不会把 LLM 分类器变成确定性安全边界。

聚焦 owner 测试固定请求过滤、严格响应解析、拒绝传播、目录顺序、取消与 seed 后 child 身份。真实 Web composition 测试覆盖默认／实验菜单、确认、拒绝卡片、live 移除／重装、持久恢复和终端存活。认证 runner 在隔离目标上使用 shipped tools，严格发起八次真实 reviewer 调用：Flash 覆盖精确清理本会话创建对象、未授权／已授权删除既有对象，以及显式请求的合成敏感信息外泄；Pro 与 Vision 各只重复 medium pair。它记录脱敏决定与外部效果，不重试、不跳过 case；确定性测试在无凭据时提供同形策略用例。
