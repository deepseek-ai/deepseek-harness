---
description: "后台任务注册表约定，供组合、实现或排查后台工作的用户与维护者阅读：id、归属、生命周期与完成监听器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs

[English](README.md) | 中文

## 概述

`dsh-jobs` 让工具可以把长时间工作注册为后台任务：工作获得稳定的 `<kind>-N` id，在 agent 继续推进的同时保持运行，拥有它的 agent 可以随时读取输出、带超时等待或请求取消。任务属于启动它的 agent 会话，因此一个 agent 的工作永远不会被另一个 agent 看到；完成以会话内通知而非轮询的方式送达给拥有者。本包只提供约定：进程本地注册表位于 `dsh-jobs-local`，模型侧控制与完成通知位于 `dsh-tool-jobs`。加载一个实现才能获得后台任务；没有实现时 `ctx.jobs` 不存在，`start()` 无法运行。

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

生产方以 kind 和一行标签注册工作；注册表返回 `<kind>-N` id，例如 `bash-1`。拥有任务的任何一方都可以读取输出、列出任务、带超时等待结算或请求取消——每次调用都返回任务状态的全新快照，从 `running`、`stopping` 到终止态的 `completed`、`killed` 或 `failed`。任务结算时，拥有它的 agent 会通过 `dsh-tool-jobs` 转成会话内通知的完成监听器得到通知，因此无需轮询。生产方还可以附加可选的字节上限，让每次完整的模型侧输出读取或完成通知保持有界。

### 归属边界

任务属于启动它的 agent 会话：其他 agent 无法读取或停止它。`bash-1` 这样的 id 可预测，因此这道隔离是授权，而非保密。没有所有者启动的任务对任何调用方开放，并持续到服务被释放为止。

### 启动后台工作需要一个控制器

只有附加了服务于所有者的控制器时，生产方才能启动工作——加载 `dsh-tool-jobs` 即附加一个。组合中未加载任何控制器的 agent 无法启动后台工作；`start()` 会以指出缺失控制器的消息失败，而不会启动 agent 永远无法收集或停止的工作。

### 最小可用组合

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
```

在已提供 agent、tools 与 system-prompt 服务的 harness 基础上加载这两个插件，即可获得完整功能：`dsh-jobs-local` 提供进程内后台任务注册表，`dsh-tool-jobs` 提供 `job_output`、`job_list`、`job_kill` 工具以及完成通知投递。

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
- **每进程一个注册表，按所有者给出答案。** 一个实例服务进程内的每套组合，因此注册与投递都相对注册方所在 scope：从不带 scope 的上下文注册的控制器或监听器服务于每个所有者；在某套 agent 组合的 scope 下注册的，恰好服务于该组合下组合出的 agent。
- **访问以所有者的会话 id 为界。** id 可预测，因此是授权——而非保密——构成边界。
- **结算首次优先，完成最后宣布。** 一条终止记录、释放的等待方，以及一轮受到隔离的监听器通知；完成在记录提交且该结算的所有其他观察者都已看到之后才宣布，因为报告方可能同步开启一个模型轮次。
- **注册的存续期长于生产方与控制器 fiber。** 所有者与服务释放会取消正在运行的工作并等待守约的生产方；抛出异常的销毁取消只强制失败记录。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：抽象 `JobRegistry` 服务及其约定 |
| [`src/types.ts`](src/types.ts) | 共享词汇：`JobKindMap`、`JobStart`、`JobHooks`、`JobSnapshot`、监听器类型 |
| [`src/brand.ts`](src/brand.ts) | `JobId` 带类型标记的标识符，无需 agent 依赖即可导入 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：校验快照标识、状态、时间戳与所有者字段 |

### 服务操作

每个操作都是已注册任务之上的薄投影：`get` 与 `list` 返回非消费式快照，`read` 推进唯一的流游标，`kill` 在改变状态前调用生产方取消，`wait` 阻塞至超时，`start()` 在调用生产方 `run()` 一次之前预检访问、校验与准入，同时拒绝任何没有已附加控制器服务的所有者；监听器按所有者粒度观察终止记录与可见集变化，`attachController` 把控制器可用性限定在其 effect 生命周期内。确切签名与行为见 [`src/index.ts`](src/index.ts) 的 JSDoc 与生成的 [`ctx.jobs` cordis 接口面](../../../docs/subsystems/jobs.zh.md)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从任务类型逐步进入随附实现、模型侧控制与设计记录。

- [后台任务运行时子系统](../../../docs/subsystems/jobs.zh.md)——任务类型、快照字段与 `ctx.jobs` 的 cordis 接口面。
- [jobs 组映射](../README.zh.md)——同级组页面及其包表格。
- [进程本地注册表](../jobs-local/README.zh.md)——在本进程中运行任务的随附实现。
- [模型侧任务控制](../tool-jobs/README.zh.md)——`job_output`、`job_list` 与 `job_kill` 工具及完成通知。
- [通用长时间运行工具运行时 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)——后台任务运行时背后的设计。
- [任务注册表 seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md)——按所有者隔离的注册表约定及其理由。

-----

<a id="model-experience"></a>
## 模型体验

通过生产方插件与控制器插件间接影响模型，它们拥有任务注册表上的全部模型渲染。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明约定何时不合适。它们是当前包约束，不是任务积压。

- **约定是进程内的**——`JobStart.run()` 传入回调和确切的 `Agent` 对象；持久化或跨进程后端必须先重塑身份、重启、所有权与观察语义，才能实现此 seam。
- **流输出只有一个消费游标**——独立观察者需要游标或快照 API。
- **前台工作无法转为后台**——生产方在启动前选择前台或后台。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
