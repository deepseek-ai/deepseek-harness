---
description: "后台任务注册表约定，供组合、实现或排查后台工作的用户与维护者阅读：id、归属、生命周期、输出环与事件流。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs

[English](README.md) | 中文

## 概述

`dsh-jobs` 让工具可以在 agent（智能体）继续推进时保持长时间工作运行。每项任务都会获得稳定的 `<kind>-N` id，拥有它的 agent 可以读取输出、带超时等待或请求取消。归属范围限定在 agent 会话内，因此其他 agent 无法查看或停止任务；任务完成时会通过会话内通知送达，无需轮询。用户可以查看保留的实时输出，而不消耗 agent 可读取的内容。只有部署提供任务执行能力时，后台任务才能启动。

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

在组合后台任务能力或编写注册长时间工作的生产方时使用本包。本包本身定义约定；组合通过加载 `dsh-jobs-local` 这样的实现，以及模型侧的 `dsh-tool-jobs`，获得该功能。

### 后台任务提供什么

生产方以 kind 和一行标签注册工作；注册表返回 `<kind>-N` id，例如 `bash-1`。拥有任务的任何一方都可以读取输出、列出任务、带超时等待结算或请求取消——每次调用都返回任务状态的全新投影，从 `running`、`stopping` 到终止态的 `completed`、`killed` 或 `failed`。任务结算时，注册表的事件流宣布它，`dsh-tool-jobs` 把结算变成会话内通知，因此无需轮询。生产方可以附加一个可选的字节上限，让每次完整的模型侧读取或通知保持有界。

生产方通过在 spec 上声明拉取源——由注册表按自己的节奏泵送的非消耗偏移读取器——或经 starter 收到的 `JobHandle` 推送块来流式输出；二者都落入该 job 的有界环，其中 `stdout` 与 `stderr` 块到达模型，`log` 块只到达观察者。观察者按绝对字节偏移读取保留块并在推进时收到信号；结束 job 的结算同时封流，在此之前 `updateProgress` 把实时进度行发布进每个投影。观测对模型不可见：`readAt` 不消耗任何东西，也从不触碰通知状态。

### 归属边界

任务属于启动它的 agent 会话：其他 agent 无法读取或停止它。`bash-1` 这样的 id 可预测，因此这道隔离是授权，而非保密。没有所有者启动的任务对任何调用方开放，并持续到服务被释放为止。

### 启动后台工作需要一个控制器

只有附加了服务于所有者的控制器时，生产方才能启动工作——加载 `dsh-tool-jobs` 即附加一个。组合中未加载任何控制器的 agent 无法启动后台工作；`start()` 会以指出缺失控制器的消息失败，而不会启动 agent 永远无法收集或停止的工作。

### 最小可用组合

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
```

在已提供 agent、工具与系统提示词服务的 harness 基础上加载这两个插件，即可获得完整功能：`dsh-jobs-local` 提供进程内后台任务注册表，`dsh-tool-jobs` 提供 `job_output`、`job_list`、`job_kill` 工具以及完成通知投递。

### 可能出什么问题

任何预检拒绝都不会留下 job id 或已注册的工作。由随附的进程内注册表管理的任务会随 harness 进程终止而消失；跨重启的持久执行需要一个实现本约定的不同后端。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释约定背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **约定与实现分属不同包。** `JobRegistry` 是抽象 Cordis 服务；直接加载该类会抛出异常，因此错误配置的组合会在加载时失败，而不是注册一个空的 `ctx.jobs`。
- **每个进程一个注册表，按所有者返回结果。** 一个实例服务进程内的每套组合，因此注册与投递都相对注册方所在 scope：从不带 scope 的上下文注册的控制器或监听器服务于每个所有者；在某套 agent 组合的 scope 下注册的，恰好服务于该组合下组合出的 agent。
- **访问以所有者的会话 id 为界。** id 可预测，因此是授权——而非保密——构成边界。
- **结算首次优先，其事件跟在每个被释放的等待方之后。** 一条终止记录、释放的等待方，然后是一轮受到隔离的事件投递；`settled` 事件报告它是否释放了一个存活的 `wait`（`awaited`），因此无论是哪个插件在等待，`dsh-tool-jobs` 永远不会播报等待方已经收走的完成。
- **注册的存续期长于生产方与控制器 fiber。** 所有者与服务释放会取消正在运行的工作并等待守约的生产方；销毁期间的取消若抛出异常，只会将记录强制标记为失败。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `JobRegistry` 服务及其约定 |
| [`src/types.ts`](src/types.ts) | 共享词汇：`JobSpec`、`JobHandle`、`JobHooks`、`JobOutcome`、`JobEvent` 与读取结果 |
| [`src/view.ts`](src/view.ts) | 客户端安全叶子：`JobView`、`JobChunk`、`JobStatus` 与可合并扩展的 `JobKindMap` |
| [`src/brand.ts`](src/brand.ts) | `JobId` 带类型标记的标识符，无需 agent 依赖即可导入 |
| [`src/archive-admission.ts`](src/archive-admission.ts) | Workspace 注册表归档准入中的 `job` 族，由接缝构造函数为每个实现安装 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：校验每个 job 的事件协议（先 registered、恰一次结算、最后 removed）以及每个通告的投影与注册表自身读取的一致性 |

### 服务操作

每个读取或控制操作接收可选的调用方 `SessionId`，省略时仅允许访问无主 job：`list` 与 `get` 返回全新投影，`read` 推进模型游标并在结算后把生产方的 result 交出一次，`readAt` 按绝对偏移读取保留块且不消耗任何东西，`kill` 在改变状态前调用生产方取消并为终态 `detail` 记录原因，`wait` 阻塞至超时，`remove` 丢弃调用方经自己的等待收走且从未交出的已结算记录，`start()` 在调用生产方 `run()` 一次之前预检访问、校验与准入，同时拒绝任何没有已附加控制器服务的所有者；`events.subscribe` 按所有者、scope 或进程粒度投递注册、进度、停止中、结算、移除与输出提交。

每个实现还会回答 Workspace 注册表的归档准入（[接缝](../../workspace/workspace/README.zh.md)），由接缝的构造函数只通过抽象的 `list` 与 `kill` 安装：`workspace/session-activity` 把被询问会话拥有的运行中或停止中任务作为 `job` 族报告，每个任务一项、附其 label；`workspace/session-stop` 以原因 `session archived` 逐个 kill 它们，因此一个在取消时抛错的生产方只记日志，该会话的其他任务仍会停止。无主任务不属于任何会话，绝不会为某个会话被报告或 kill。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从任务类型逐步进入随附实现、模型侧控制与设计记录。

- [后台任务运行时子系统](../../../docs/subsystems/jobs.zh.md)——任务类型、投影字段与 `ctx.jobs` 的 Cordis 接口面。
- [jobs 组映射](../README.zh.md)——同级组页面及其包表格。
- [进程本地注册表](../jobs-local/README.zh.md)——在本进程中运行任务的随附实现。
- [模型侧任务控制](../tool-jobs/README.zh.md)——`job_output`、`job_list` 与 `job_kill` 工具及完成通知。
- [通用长时间运行工具运行时 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)——后台任务运行时背后的设计。
- [任务注册表 seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md)——按所有者隔离的注册表约定及其理由。
- [jobs seam 收敛 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-03-jobs-seam-consolidation.zh.md)——一个输出环、一个投影、一条事件流。

-----

<a id="model-experience"></a>
## 模型体验

通过生产方插件与控制器插件间接影响模型；它们负责基于任务注册表完成所有面向模型的渲染。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明约定何时不合适。它们是当前包约束，不是任务积压。

- **约定是进程内的**——`JobSpec.run()` 传入回调，注册表解析拥有者会话背后的活体 `Agent`；持久化或跨进程后端必须先重塑身份、重启、所有权与观察语义，才能实现此 seam。
- **模型游标是唯一的消耗式读取**——独立观察者使用非消耗的 `readAt`，从不移动它。
- **已结算记录会一直列出直到被移除**——由持有者释放、服务释放，或收走它的调用方显式 `remove`；注册表不对已结算 job 保留任何数量上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
