# Agent Note: 会话首帧读取的缓存身份与调用时序

Status: implemented

[English](2026-09-20-session-open-read-coordination.md) | 中文

## 问题

打开历史会话时，`session.follow`、输入框目录预热和依赖 Agent 参数的 RPC 可能同时访问同一份冷日志。`skills/list` 自行请求完整 observation；`commands/list`、`goals/get`、`fileReferences/list` 与 `sessionReferenceResolver/candidates` 则可以在参数解析阶段经 Agent lookup 发起恢复。辅助请求不等待历史首帧，会与主对话争用读取、解析和 projection 计算，而不是复用已经完成的结果。

完成后的 observation 复用还有一个独立问题：Cordis 对同一服务的访问可以返回不同代理对象。以 `ctx.get('sessionPersistence')` 返回对象的引用相等性判断服务身份，会把同一底层服务误判成另一个实例。另一方面，彻底去掉实例身份检查也不安全，因为持久化 revision 只在对应服务实例和 Session 身份内可比较。

子会话导航混合了两种需求：展示一个已知地址的对话，以及发现该会话的父目录或后代目录。已有父子地址的导航再次刷新 parent projection，既增加前置工作，也会在目录缓存缺席时拒绝一个本可由 Host 校验并打开的地址。

## 决策

### 用服务自身的 Symbol 标识缓存生产者

`SessionPersistence.identity` 是每个服务实例创建一次的 `Symbol('sessionPersistence')`。代理访问保留这个值，服务被替换后新实例获得不同值。Prepared observation cache 按 Session id 查找，并同时比较 `persistence.identity` 与 `stat().revision`；相同实例、相同 revision 可以复用已完成的 preparation。

该身份只存在于进程内，不进入 Session header、事件或持久化文件。现有缓存容量、lease、live 优先级和 revision 失效规则不变。这个修复不增加尚未完成的冷读取之间的 Promise 合并；稳定身份解决的是完成后的误失效，不是所有调用方的并发去重。

### 辅助 RPC 等待当前对话的首次打开成功

Client 在实际 RPC 发送位置使用既有 `sessions.using()`，不只延迟预热钩子。菜单候选、显式引用查询和后续目录刷新因而经过相同的等待入口。每个操作先确认目标已经有 Client binding，不因后台预热重新打开一个已经关闭的会话。

| Client 消费方 | 等待后的 RPC | 临时引用来源 |
| --- | --- | --- |
| Skill 目录 | `skills/list` | `skillCatalog` |
| Command 目录 | `commands/list` | `commandCatalog` |
| Goal 激活状态 | `goals/get` | `goalActivation` |
| `@` 文件与会话候选 | `fileReferences/list`、`sessionReferenceResolver/candidates` | 共用 `referenceCandidates` |

`sessions.using()` 先等待 `reference.ready`，再等待操作返回的 Promise，最后释放自己的引用。`ready` 表示首次 `Session.open()` 尝试已结算，不保证成功；这些消费方还检查 `openState === 'open'`，失败时不发送辅助 RPC。Goal 读方还确认捕获的 binding 未被替代，并记录读取拒绝而不清除已有展示状态。

Skill 保留共享目录请求自己的取消信号；`@` 查询将当前候选请求的信号用于历史等待和两个 RPC。未加引号的 `@` 在等待后仍并行查询文件和会话，加引号的路径仍只查询文件。Command 与 Goal 不新增取消协议。这里的引用持有 Client 数据和跟随流，不赋予 Host Agent 新权限，也不禁止首帧之后发生正常 Agent 恢复。

### 对话使用 follow，目录分支保留显式读取

主对话的 `follow` 首帧已经携带该 Session 的完整 projection baseline。后续共享 projection 值变化会通知订阅者，不需要在切换会话或打开菜单时再次读取相同 baseline。

- 主视图切换不再额外刷新所选 Session 的 projection；恢复保存的子会话地址不再预先刷新其 parent。
- 侧栏从完整父子地址直接保留目标子会话，不把父目录读取作为打开对话的前提。
- Header 下拉菜单的 `changeOpen` 只改变展示状态，不刷新 `rootSessionId`。展开子节点和失败重试仍调用显式刷新，UI 回调命名为 `refreshProjection`；底层 `sessions.refreshProjections` API 不改名。
- Team 点击使用已有 lead 与 roster 成员 id，直接打开 `{ parentSessionId, childSessionId, mode: 'continuable' }`。它不刷新 parent catalog，也不要求目标预先出现在 Client catalog 中；成员角色、主视图持有检查及 UI 对 provisioning、failed 成员的限制保持不变。

已知地址不等于免除授权校验。Host 在打开子会话历史时，仍检查目标自身 header 的 parent、origin，以及自身 `subagent` projection 的 mode 和描述符归属。后续 continuation 仍受直接 parent 的既有授权规则约束。

## 实现边界

- 没有修改 Session 格式、迁移、Host observation 的 `all | none` 策略或 `session.projections` 返回字段。
- 没有实现全局 cold-read singleflight，也没有把所有 Agent lookup 改成只读 lookup。
- 没有删除 `SessionManager.handleConnected()` 对此前请求目录的批量刷新；本决策不保证重连只有一次冷读。
- 工具侧 `listDescendants` 观察每个可达子级目录。观察可以复用实时状态或有效的 prepared Session，否则会读取冷日志。前端展开子节点也可能冷读该节点。普通主会话首开不等于所有后代枚举场景。
- `@` 会话候选仍枚举 header，并从 live projection 或 projection cache 取名称；缓存缺失回退到 id。原有排序、默认 50 条上限和直接 subagent 分组规则不变，没有改成沿 `subagentCatalog` 递归发现。

## 考虑过的替代方案

**取消 persistence 实例比较。** 不采用。同一个 Session id 和 revision 不能证明两个持久化服务提供同一份数据；服务替换仍必须使旧 preparation 失效。

**在调用方解包 Cordis 代理或按 Context 缓存服务对象。** 不采用。缓存需要的是生产者身份，而不是某次服务访问返回对象的身份；每实例 Symbol 足够表达这个要求，不需要传播代理实现细节。

**为所有冷读增加统一 singleflight。** 未纳入本次实现。它可以合并更多并发调用，但需要另外定义独立等待方取消、lease 和服务替换期间的任务归属；它也不能代替“辅助 RPC 不抢在首帧前恢复 Agent”的时序要求。

**只延迟 warm，或只给额外 projection 请求补 await。** 不采用。显式菜单查询仍能绕过 warm；串行执行一个重复 projection 请求也没有删除重复工作。等待放在实际辅助 RPC 入口，已有 follow 能提供的读取直接取消。

**保留 Team 的父目录存在性检查。** 不采用。Team roster 已给出成员身份，显式地址可以由现有 Host 历史入口验证；把 Client catalog 缓存命中作为导航前提，会把数据尚未加载误当成子会话不存在。

## 后果

普通主会话先完成自己的历史和 projection 读取，辅助操作再复用已完成的 observation 或已挂载状态。前端直接子代列表消费主会话的 catalog，不为显示每一行读取对应子会话正文。目录与对话的打开入口分开，导航到一个已知子会话不再附带 parent projection 预热。

代价是辅助目录首次可用时间晚于对话首帧；操作还会持有临时 Client 引用直到结束。该等待只对应当前 Client generation 的首次打开，不是每次底层 follow 重建的就绪屏障。所有重连和异常重试场景仍需各自验证。

Header 根目录缺失仍是明确的覆盖缺口：若它属于未打开的 parent，且没有其他来源提供 catalog，仅打开下拉菜单不会补读；现有 UI 仍可能显示加载提示。本次没有增加新的父目录加载入口，也没有实现统一的 unknown 交互协议。

## 验证与已知缺口

用户在本地长历史主会话切换流程中，通过临时 `readColdSessionLog` 计时和调用栈观察到重复调用收敛为一次，并验证了 teammate 直接导航。这个结果只描述该操作的冷读辅助函数调用次数，不代表所有底层文件 I/O、全部重连场景或端到端性能都只有一次成本。诊断期间的私有 Session 内容和身份不作为测试 fixture。

开发期对相关包执行过定向 TypeScript 构建与打包；尚无这批完整变更的门禁、行为测试或组装 Web 快照验证结果。现有测试只完成部分回调改名，仍有旧 fixture 名称、打开根菜单即刷新、侧栏先刷新 parent，以及 Team 拒绝缺失 catalog 的预期需要调整。这些是已知验证缺口，不是已经通过的检查。

## 与既有记录的关系

- [Session observation 与 projection 所有的客户端状态](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md)继续拥有读取切面和共享值的职责划分。本记录补充缓存生产者身份与首帧消费顺序；旧记录中“包括未完成冷加载的共享”描述与当前 reader 实现不一致，不能作为本次 singleflight 已实现的依据。
- [Client Session 引用、引用来源与 UI 状态](../architecture/2026-09-15-client-session-references.zh.md)继续拥有 `retain`、`ready`、`using` 与显式地址语义。本记录限定四类辅助读取作为独立异步操作持有临时引用，不把额外引用扩展到所有 UI 动作。
- [Web 子代理目录消费共享 projection](../simplification/2026-09-08-web-subagent-catalog-projections.zh.md)继续拥有通用 projection store、显式目录读取和 control 更新。本次实现落实“打开会话使用 follow baseline”的规则，不替换整个目录机制。
- [Web subagent 目录与用户继续交互](../feature/2026-07-27-web-subagent-conversations.zh.md)继续拥有展示和 continuation 授权。本记录只调整导航前置读取及根菜单刷新时机，不取消子会话自身的 Host 校验；旧记录对缺失根目录交互加载的描述需与这里的覆盖缺口一起核对。
