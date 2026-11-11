---
description: "面向用户与维护者的 subagent 委派 seam，用于选择提供方后端、组装委派工具或排查子 agent（智能体）运行问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

## 概述

`dsh-subagent` 通过具名提供方委派工作，并收集受管理 activation 的结果。本地 spawn 和 fork 子级保留持久会话以接受后续消息；ACP、DSH SDK、Codex 与 Claude Code 执行一次。所有子级共享准入、取消、所有权与发现机制。使用时组合服务、提供方和委派工具。

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

每次启动可传入可选的 `cwd`；相对路径以父级当前工作目录解析，省略时捕获该当前目录。子级保留父级的起始目录元数据与权限根目录。子级自己的目录值位于继承历史之后，在继续与重启后保留，并独立于父级之后的目录变化。

本包是每个委派组合都共享的约定。你通过把服务与一个或多个提供方后端以及面向模型的委派工具一起挂载来启用它；此后 agent 即可委派工作，服务会把每个请求路由到具名提供方。

### 启用委派

一起挂载本服务、`@deepseek-ai/dsh-session-projection`、提供方与委派工具；本服务等待投影注册表可用后才初始化。提供方按配置名称注册，每个工具行选择一个提供方。最小配置如下：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

工具立即返回子级的名称，后台 activation 结算后父级收到完成通知。仅挂载服务本身不会启用委派。

### 委派设置

**插件 → 子智能体**页面的限制部分编辑 Host 的 `subagent` 设置分节。用户值覆盖本插件的组合配置；恢复默认会删除用户覆盖。`maxDepth` 默认为 `1`，在委派工具自身未配置深度时提供默认值。工具显式指定的深度（包括 `provider-managed`）优先。深度 `0` 禁止继承此设置的工具委派；深度 `1` 只允许直接子代理。修改在下一次委派时生效。直接调用服务的调用方仍自行提供可选的请求深度。

### Activation 容量

在 Host 插件上设置 `maxActiveSubagents`，限制每棵 subagent 树中在线和正在创建的子级数量。默认值为 `8`，接受正安全整数。顶层父级建立由本地和外部后代共享的池，根父级不占名额。新建和冷恢复在让出执行前预留名额，资源释放完成后才归还。有待处理收件箱内容以及正在停止的 activation 仍计入容量；向驻留子级发送消息复用其名额。委派深度是独立策略。

每次新建或冷恢复 Activation 前都会读取当前 `maxActiveSubagents`。调高后已有树可接纳更多子代理；调低后驻留子代理继续运行，使用量降至上限以下前拒绝新接纳。

容量耗尽时，新建或冷恢复以 `ACTIVATION_LIMIT_REACHED` 拒绝（浏览器消息返回 `subagent/delivery-unavailable`）：等待子代理完成，或继续使用现有代理。接纳不会排队，避免等待后代的父代理又等待自己占用的名额。名额仅存在于当前进程，不限制累计 Session 历史或 token 用量。

### 本地与外部子级

`startActivation({ provider, label, name?, prompt, parent, signal, delivery })` 返回 `{ childId, name, messageId?, result, dispose }`。提供 `childId` 会选择本地后端，并保证返回 `messageId`。本地子级接受后续消息并支持冷恢复；外部子级只暴露一次执行，拒绝继续输入。`agentOptions` 覆盖后端支持的子级模型设置。`delivery: 'parent'` 提供面向模型的完成通知；`delivery: 'caller'` 让工作流等待结果，不发送父级通知，也不附加初始返回指导。本地父级投递需要持久化，调用方投递可以使用临时本地会话；冷恢复需要持久化与 Session 查询服务。

`rootOf(agent)` 通过托管本地 Agent 已有的 Activation 解析树根，并校验子级和树根的确切存活实例。中间创建者退出不改变该树根；同 id 替代实例不能继承成员身份。普通存活 Agent 返回自身，非托管的委派 Agent 会被拒绝。查询不会激活 Session。

<a id="agent-names"></a>
### Agent 名称

每个进入目录的子级都有一个名称，在其创建者的子级之间唯一。传入 `name` 可选择名称：1–32 个小写字母、数字或连字符，以字母开头，且不能是 `lead`。省略时，运行时在创建者目录中的名称以及仍在启动的创建所持有的名称之外，选择第一个空闲的 `agent-N`（`agent-1`、`agent-2`……）。请求同级已持有的名称会以 `DUPLICATE_AGENT_NAME` 拒绝，不符合规则的名称会以 `INVALID_AGENT_NAME` 拒绝；两者都在启动前拒绝，运行时绝不替换为其他名称。创建者在准入时同步预留名称，并在目录条目提交或启动失败时释放预留。调用方投递的外部执行不进入目录：请求名称时以 `UNSUPPORTED_CAPABILITY` 拒绝，其 activation 名称为其 Session id。

根的名称始终为 `lead`。后代的完整名称是从根开始、以斜杠分隔的名称路径，不带 `lead/` 前缀，例如 `reviewer` 或 `reviewer/checker`；同级唯一的各段使完整名称在整棵树中唯一。`SubagentActivation.name` 和 `listDescendants()` 行的 `path` 字段携带完整名称。目录条目没有名称的子级及其下所有后代使用 Session id 作为名称。`namesOf(agent)` 报告在线成员及其创建者的名称。`resolveName(caller, name, signal)` 为 `lead` 或完整名称返回 Session id，只读取路径上的目录。树中不存在的其他文本原样作为 Session id 返回，因为单个词元可能就是 Session id；斜杠路径不可能是 Session id，因此指向无成员的路径以 `AGENT_NAME_NOT_FOUND` 失败。解析不授予权限：消息、中断和任务分配会对解析出的 Session id 进行授权。

### 子级 preset

进程内 spawn 接受独立的 `agentPreset`；fork 与外部后端拒绝此选项。省略选择时，本地子级加入父方当前的 preset 代际。显式 id 挂载当前可用代际，即使该 id 与父方相同。通过 [`dsh-tool-subagent`](../tool-subagent/README.zh.md#selecting-a-child-preset) 配置模型可选项，并在 [preset 组装](../../preset/agent-preset-registry/README.zh.md)中配置 persona 与工具。冷恢复保留历史子级 descriptor 记录的 persona 和工具限制。

### 消息、中断与发现

`sendMessage()` 允许在线根和驻留的可继续子代理，按 Session id 联系同一棵树中的任意其他根或可继续成员。目标在下一步接收 Steer 输入，或在空闲时开始轮次。仅在 subagent 树根下恢复冷目标，其创建祖先保持离线；消息保留实际发送者。`rootOf()` 解析调用方的在线根。Agent 中断要求祖先权限。浏览器提示词和用户中断仅按子 Session 寻址；Gateway 在任何副作用之前检查该 Session 上对应操作的权限。父级或 global 授权不意味着子级访问权。提示词要求 subagent 树根在线；创建者可以离线。用户中断不恢复目标，目标缺席时接受为无操作。提示词选择 Queue 或 Steer，经附件存储接受图片批次；不兼容的目标模型拒绝图片。`listDescendants()` 通过父级拥有的 `subagentCatalog` 投影递归发现成员。它保留目录顺序，每个可达 Session 读取一次，跳过外部叶子，并报告不可读分支而不激活 Agent。

### 失败与恢复

每个 `SubagentError` 都携带 [`src/error.ts`](src/error.ts) 中封闭联合类型 `SubagentErrorCode` 的一个 code，该文件逐条说明各条件。缺少 `agents` 服务时，启动请求以 `CONTINUATION_UNAVAILABLE` 拒绝；运行时可用但父级缺失或被替换时，以 `UNAUTHORIZED` 拒绝。未实现任何执行方法的提供方会在注册时以 `UNSUPPORTED_CAPABILITY` 被拒绝；请求不受支持的能力会以同一码使创建失败。如果等待目录解析期间提供方被移除或替换，创建会在调用任何一方之前以 `PROVIDER_CHANGED` 拒绝；调用方可根据当前注册重试委派。以下创建失败均为 `SubagentError`：超出请求深度的子代以 `SubagentDepthError` 子类和 `DEPTH_EXCEEDED` 拒绝，无效的运行时 `subagentDepth` 以 `INVALID_DEPTH` 拒绝，选择了 preset 但缺少 preset 服务时以 `PRESET_UNAVAILABLE` 拒绝（所选 preset 未知或无法加载时保留 registry 的 `RemoteError` code），缺少工作目录服务的本地子代以 `WORKING_DIRECTORY_UNAVAILABLE` 拒绝，cwd 为相对路径或不可进入的进程外子代以 `INVALID_CWD` 拒绝。持久化 descriptor 损坏的冷目标以 `NOT_RESUMABLE` 拒绝，有待处理输入时调用 `structured_output` 以 `STRUCTURED_OUTPUT_PENDING_INPUT` 失败。调用方信号仅取消尚未发布的工作；发布后通过 `dispose()` 取消该次 activation，并等待其资源清理完成。创建后代独立继续运行；宿主必须在释放根句柄前等待 `drainDescendants([root])`，以停止所有成员并等待正在启动的工作。`result` 在清理与通知结束后完成，携带输出、可选结构化数据与停止原因；结果捕获故障在清理后使其拒绝。清理失败使 `dispose()` 拒绝，并将生命周期结束事件标记为失败；结果 promise 与父级通知保留已捕获的执行结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务的构建方式以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **一个服务，多个提供方。** 服务是具名提供方注册表；每个后端以唯一名称注册，请求按名称选择一个。
- **统一受管理生命周期。** `SubagentManager` 统一管理启动、消息准入、容量、运行归属与释放。每条 activation 持有生命周期标识和本地 AgentHandle 或外部 SubagentRun；manager 通过服务的作用域事件发送器发布成对事件。本地 inbox 与空闲状态仅属于本地分支。
- **兑现即发布。** `startActivation()` 仅在子级已接受且句柄可取消该次执行后返回。
- **同进程值可信。** 请求、描述符与结果按不可变约定借用；序列化与不可信输入校验属于进程与协议边界。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：提供方注册表、启动与继续 API、生命周期事件 |
| [`src/manager.ts`](src/manager.ts) | 统一管理启动、消息准入、冷恢复、运行归属、结算与释放 |
| [`src/activation.ts`](src/activation.ts) | 执行期记录、容量槽、子级锁与本地输出捕获 |
| [`src/continuation-messages.ts`](src/continuation-messages.ts) | agent 消息、返回指引与结算通知 |
| [`src/structured.ts`](src/structured.ts) | Activation 局部结构化捕获与保护 |
| [`src/types.ts`](src/types.ts) | 公开的请求、结果与提供方约定 |
| [`src/descriptor.ts`](src/descriptor.ts) | 版本化的 `subagent/descriptor` 会话事件词汇 |
| [`src/catalog.ts`](src/catalog.ts) | parent 自有的 `subagent/catalog` 事件与分块 host projection |
| [`src/child-agent.ts`](src/child-agent.ts) | 子级组装、委派策略、深度辅助函数 |
| [`src/list-children.ts`](src/list-children.ts) | 直接与递归的 parent 目录读取 |
| [`src/control.ts`](src/control.ts) | 浏览器控制请求校验与稳定失败分码 |
| [`src/control-types.ts`](src/control-types.ts) | client-safe 的目录行、控制面请求、回执与失败 |
| [`src/archive-admission.ts`](src/archive-admission.ts) | Workspace 注册表归档准入中的 `subagent` 族：运行中的子孙及其父级取消 |

### 提供方准备与结构化输出

服务在创建前校验请求能力，并把执行绑定到该确切提供方实例。管理器接收绑定后的操作，而不再按名称查找提供方。本地提供方只提供 `prepareContinuable()`：spawn 返回全新状态，fork 返回已完成轮次的初始内容。管理器在创建子级前捕获父级模型设置、委派权限和组合。外部提供方保留 `start()` 作为传输适配器，并保留各自的权限系统；统一管理器拥有已发布的执行。结构化工具、指令、校验与终止保护仅属于一次本地 activation，不作为恢复配置持久化。子代理消费已接受的输入后即可提交结构化结果。依赖后代结果的工作必须显式等待。结果暂存后，在工具结果策略及外层 PTC 执行完成前拒绝继续输入；结果被拒绝后重新开放输入，提交成功后则保持关闭。后续冷恢复不带结构化 schema。

外部提供方为每次执行生成新的 `SubagentRun.id`，在运行时共享的 Session id 命名空间中跨所有父级和提供方保持唯一。与驻留 Agent、Session 或 activation 冲突时，启动以 `DUPLICATE_CHILD` 拒绝，并释放新的外部句柄，不替换已有执行。

### Activation 结算

管理器预留子级身份与容量，创建本地 Agent 或外部执行，并接受初始任务。本地 Agent 活动和待处理输入结束后，管理器在最终 Session flush 后重新验证活动状态并关闭准入。本地与外部 activation 都在句柄清理、容量归还及结算通知结束后交付结果。宿主在 subagent 树根上等待仍在推进的成员及其清理，包括失败的执行；有停放输入的空闲成员继续驻留，但不延迟宿主完成。普通成员不等待后代。关闭准入并释放句柄可防止迟到工作进入已释放的 Agent。父级投递仅在创建者仍在线时于结算后发送通知；调用方投递由等待中的工作流收集。Headless 宿主交替等待 `agent.whenIdle()` 与 `waitForTreeWork(agent)`，直至没有子级工作，且父级在检查子级期间保持空闲、Session 序号不变，让完成通知可驱动父级生成最终答案。本地 Agent 因工厂卸载而释放时，管理器在 Agent 停稳并离开注册表后结算其 Activation。如果关闭失败时仍有待处理输入，原本为 `completed` 的结果改为报告 `error`，并保留已经生成的输出。

结算归属信息记录确切的执行停止原因，不改变面向模型的通知内容。历史通知可以缺少该字段；读取方不得从英文摘要推断它。

本地 Agent 发生失败且后续没有成功提交 `turn/end` 时，会独立于后代以 `error` 结算。未认领的输入不会使该失败 activation 一直驻留。后续成功提交的轮次结束记录会取代实时失败，提供恢复后的结果。

本地创建成功后，无论结果交付给谁，都会向父 Session 追加 `subagent/catalog` 事实。外部创建仅在使用 `delivery: 'parent'` 时追加目录事实；调用方拥有的外部执行保留调用方自己的成员记录。外部条目以 `mode: 'external'` 标记没有本地 Session 的子级。目录仅在创建时记录一次成员关系，不携带执行状态。完整结果交给调用方或父级完成通知。投影排除继承事实。直接列表读取一个父级投影，因此已完成的本地工作流子级仍可被发现、打开或继续。Catalog 载荷 v0 记录本地模式，v1 还接受未知模式，v2 记录外部执行，v3 为可继续和外部条目增加子级名称。本地创建和父级投递的外部创建写入 v3，读取器支持全部四个版本。`subagentCatalog` 投影状态版本保持为 6：复用无名检查点，后缀回放追加具名事实，不重新回放检查点前缀，也不回填历史名称。历史迁移在 descriptor 不可用时根据可读子 header 追加 v1 `subagent/catalog`。其 `mode: 'unknown'` 投影让子会话保持可见，但不表示支持继续执行；已有完整条目仍具有权威性。

<a id="restoring-child-composition"></a>
### 恢复子级组装

冷恢复从目标的 `agentPreset` 投影或创建 header 读取已保存的 preset 并挂载，不读取创建者当前组装。已保存的 preset 缺失或损坏时拒绝恢复。原始 subagent 提供方不必仍然注册。

没有保存 preset 的目标使用宿主组装，并保留历史 descriptor 中的 persona 和工具限制。持久权限策略从目标自身日志回放。恢复使用当前注册的 preset 定义，不跨重启保留旧代际。

### 所有权与不变式

- **管理器拥有已接受工作**——未发布的失败会回滚；已发布句柄仅取消并释放确切 activation。所有实例归 subagent 树根管理；创建父级 id 保持不变。
- **注册受 effect 作用域约束**——移除提供方会阻止新启动，但绝不撤销已接受的运行。
- **Agent 消息权限由树决定**——确切在线发送者和目标必须属于同一个根。冷投递验证目标描述符和创建目录后仅恢复目标。最终收件箱准入重新检查发送者与 subagent 树根；恢复失败释放新建实例。
- **描述符仅进日志**——它是会话事件，不进入模型历史，并跨压缩（compaction）保留；写入器记录解析后的子级提供方、模型与推理强度，用于冷恢复。历史 one-shot 描述符仍可读取。
- **本 runtime 为子代理回答归档准入**（[接缝](../../workspace/workspace/README.zh.md)）——活动查询、以父级原因取消和步骤执行前的拒绝都使用托管实例的创建祖先，即使中间创建者已离线。尚无已发布 Activation 的 Agent 使用在线 header 血缘；普通 fork 保持独立。名称取自当前身份投影中的最新 descriptor，且该 descriptor 必须属于孩子自身的日志；身份缺失、无效、来自继承或没有名称时只报告 id。报告不依赖 Session query 服务，并在身份投影注册完成后启用。每次取消的失败都单独收敛。Agent 注册表拥有父级回合，job 提供方拥有任务，API Session Controller 检查已归档 Session 和可用的 header 血缘。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享 seam 逐步进入后端、面向模型的工具与设计决策。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [历史Subagent 能力 seam](../../../.agents/notes/archived/feature/2026-06-21-subagent-capability-seam.md)——委派能力家族的设计记录。
- [可继续的 subagent](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)——接受后续轮次的持久子级。
- [进程内 spawn 后端](../subagent-spawn-in-process/README.zh.md)——最容易组合的提供方。
- [Auto review](../../experimental/auto-review/README.zh.md)——只有进程内 DSH 子级继承的当前会话授权模式。
- [进程外 ACP 后端](../subagent-acp/README.zh.md)——经 Agent Client Protocol 拥有自有运行时的子级。
- [DeepSeek 输入转换](../../llm/llm-deepseek/README.zh.md#model-experience)——已保存结算通知的提供方回放规则。
- [tool-subagent-control README](../tool-subagent-control/README.zh.md)——后续消息、中断与列举面。

-----

<a id="model-experience"></a>
## 模型体验

### 结算通知

#### 模型看到什么

父级投递向同树中驻留的直接父级发送 user-role 状态通知，包括空闲父级。它不会恢复离线父级。首行使用子级的完整名称，例如 `Background subagent reviewer finished and will do no further work unless you send it more.`。通知包含子级最终输出中的非空文本块。若子级在该文本之前的最后一个动作是向父级发送消息，且此后既未领取输入也未记录任何工具调用，通知会以 `It sent you a message just before finishing, so its closing message is omitted.` 替代这些文本块；父级只有再次向子级发送消息才能取回被省略的收尾文本。外部通知还说明不支持后续消息。推理及其他非文本块被排除。每条父级通知都会以 `Structured result: <JSON>` 附带可用的结构化输出，并以独立文本块附带提供方安全诊断。收尾文本为空时，通知使用 `It left no closing message.`。调用方投递不发送通知；清理成功时 SDK 生命周期通知保留完整子级输出。

#### Token 影响

父级投递为每个结算的 activation 添加一条通知；`agent-1` 等默认名称比没有记录名称的子级所用的 36 字符 Session id 更短。调用方投递不添加完成消息，由其消费者负责展示结果。

#### KV Cache 影响

在父级中仅追加：通知位于其可复用请求前缀之后。到达空闲父级会启动一次独立的模型请求，到达繁忙父级则不会。

### 可继续执行子级的返回指导

#### 模型看到什么

采用 `delivery: 'parent'` 的本地子级会在初始任务中收到以下结果交付指导，与是否安装通信工具无关。工具用法和通信身份由 [tool-subagent-control](../tool-subagent-control/README.zh.md) 提供。

##### 返回指导

```markdown
Your final answer is delivered automatically if your parent is still online. Include the result and relevant evidence in that answer; the parent does not receive your full transcript, tool output, or reasoning. If your last action is a message to your parent, the completion notice omits your final answer; include the result and relevant evidence in that message.
```

#### Token 影响

每个采用父级交付的本地子级初始任务增加一个固定指导块；调用方交付不增加。

#### KV Cache 影响

指导保留在子级的任务历史中，不改变父级系统提示词。

### 子级委派范围声明

#### 模型看到什么

每个进程内子 agent 的运行时上下文快照都携带下方的 `subagent:delegation` 声明，位于沙箱策略与审批策略语句之后。

##### 委派范围声明

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token 影响

每个子 agent 的运行时上下文快照中一条固定声明；父级请求中没有任何新增。

#### KV Cache 影响

子级内部前缀稳定：该声明在子 agent 生命周期内绝不变化，因此只写入第一份运行时上下文快照一次。父级侧不会直接使缓存失效；具名工具消费方共同负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用委派对比或任务积压。

- **后代读取串行执行**——每个可达目录（包括一次性子级）都需要一次观察。冷 Session 缺少有效的 prepared 观察时需要读取完整日志；大型冷会话树可能累积存储延迟。
- **名称不可变更**——只要目录条目存在，名称就在创建者的子级之间保持占用；名称不能修改或复用，也没有迁移为早于名称机制的目录条目补充名称。
- **外部子级执行一次**——ACP、DSH SDK、Codex 与 Claude Code 没有本地子 Session，也不接受后续输入。释放后仍可发现父级拥有的执行记录。
- **消息限定在一棵树内**——目标必须是根或可继续成员。仅恢复的目标占用激活容量。浏览器提示词保留独立的人类 Queue 或 Steer 控制路径。
- **取消收敛期间存在唤醒缺口**——中断信号发出后、Agent 进入 idle 前被接受的后续消息会保持排队，直到另一条唤醒发送到达。
- **待处理的注入上下文会保留 Activation**——settlement 会保守地把每个 Inbox occurrence 都视为未完成。Agent 进入 idle 后停放的上下文会让 child 及其在线祖先继续驻留，直到唤醒投递将其 claim、queue 变更将其移除，或 manager teardown 将其丢弃。宿主完成检查等待活动工作、待创建子级与资源清理，但不会等待仅包含空闲停放 Inbox 的子树；它既不结算这些 activation 的结果，也不丢弃其消息。
- **驻留仅限进程内**——Activation inbox 与所有权图不会在两个 harness 进程之间协调；对单个持久化存储的并发访问需要持久化邮箱与跨进程租约协议。
- **不回放已接受但未记录的消息**——崩溃可能丢失从未写入子会话日志、已被接受的提示词；丢失的消息不会自动回放。
- **生命周期事件只供观察**——影响运行的 `subagent/end` 延续或决策接口仍需等待具体消费方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **跨进程继续执行**——持久化邮箱与租约协议可让两个 harness 进程共享一个持久化存储。
- **可继续 ACP 子级**——需要持久化远程会话 id 与逐子级的继续执行能力声明。
- **host-user 投递**——未来的 host 适配器需要具体的经认证交互，该 seam 才能获得用户投递能力。

</details>
