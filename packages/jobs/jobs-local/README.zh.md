---
description: "进程本地后台任务注册表，供组合、容量评估或排查进程内任务的用户与维护者阅读：按所有者的准入、生命周期与销毁。"
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs-local

[English](README.md) | 中文

## 概述

`dsh-jobs-local` 在 agent（智能体）继续推进时，于 harness 进程内运行后台任务。拥有任务的 agent 可以读取、等待、列出和取消任务；同时挂载 `dsh-tool-jobs` 时，还会收到会话内完成通知。可配置的并发与输出保留上限约束资源使用。生产方可以提供供定期读取的输出，也可以直接追加；用户可以观察保留的输出，而不消耗 agent 尚未读取的内容。任务在拥有者或 harness 关闭时结束。

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

当组合需要进程内后台任务时加载本插件：长时间运行的工具注册其工作，拥有它的 agent 在不阻塞自身轮次的情况下读取、等待、列出和取消。它实现 [`dsh-jobs`](../jobs/README.zh.md) 约定；模型侧的 `job_output`、`job_list` 与 `job_kill` 工具来自 [`dsh-tool-jobs`](../tool-jobs/README.zh.md)。

### 何时选择

当任务应存活于 harness 进程内、并随进程终止时选择它。当工作必须跨重启存活或跨进程存在时避免它：记录保存在内存中，持久或跨进程后端必须以不同方式实现同一约定。

### 最小配置

加载插件即注册 `ctx.jobs`；每个字段都是可选的。

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrentJobsPerOwner` | `10` | 每个精确所有者，或共享的无主桶中，`running` 加 `stopping` 任务的最大数量 |
| `retainBytes` | `262144` | 每个任务输出环的运行期保留量，UTF-8 字节 |
| `settledRetainBytes` | `16384` | 任务结算后保留的环容量，UTF-8 字节；模型尚未读取的字节保留到它的首次终态读取 |
| `pumpPollMs` | `150` | 任务拉取源的轮询间隔，毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-jobs-local)是每个受支持字段的穷尽式真源。

### 每个所有者得到什么

上限统计精确所有者的 `running` 与 `stopping` 记录；所有无主任务共享另一个独立的服务级桶。终止历史不占用容量，只有生产方的 `done` 结算才释放一个停止中任务的名额。达到上限时，`start()` 会在生产方运行前失败，错误会指出上限并告诉 agent 终止一个不需要的任务、等它结束后再重试——注册表既不排队也不抢占。

### 生命周期

任务属于其所有者和后端，而非生产方工具，因此重载生产方或控制器不会停止任务。拥有任务的 agent 被释放时，其任务会被取消、生产方会被等待、快照会被移除；服务释放对每个剩余任务执行同样的操作。销毁期间抛出的取消会强制失败记录并警告工作可能成为孤立工作，因此销毁永远不会死锁。

### 可能出什么问题

没有服务于所有者的控制器时无法启动工作——加载 `dsh-tool-jobs` 即附加一个，否则 `start()` 会以指出它的消息拒绝。返回但始终未结算 `done` 的生产方取消与缓慢停止无法区分，可能使销毁停滞并持续占用一个容量名额。每条记录都会在 harness 进程退出时消失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释注册表背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **内存记录、全新投影。** `LocalJobRegistry` 为每个任务保存一份 `TrackedJob`——生命周期状态、输出环与模型游标——每次调用都投影新的只读视图或块副本；调用方永远拿不到实时状态。
- **环的保留量有界。** 追加超出运行期上限时丢弃最老的保留块（单个超限块保留其 UTF-8 安全尾部）；低于保留窗口的读取得到 lossy 结果而非错误。结算时裁剪到结算上限，但绝不低于模型游标尚未消费的字节数，因此在首次 `job_output` 之前结束的任务会交出运行期上限保留的全部输出；那次终态读取之后才裁剪到结算上限。
- **按所有者分层，一个进程级注册表。** 控制器与 `{ owners: 'scope' }` 订阅归档到注册方所在的 scope（`ScopedLayers`），读取把全局层与所有者的 scope 链求并集——因此某个 preset 的任务控制绝不会为自身组合未加载任何控制器的 agent 保持 `start()` 可用，一次带 scope 的结算也只会抵达其所有者所属组合注册的监听器。
- **启动前先预检。** `start()` 在调用生产方之前检查控制器服务、spec 有效性、仍存活的所有权与容量，因此拒绝不会留下 job id 或执行资源；注册一旦提交，后续不再有可失败步骤。
- **结算首次优先，事件最后。** 最早的终止结果只记录一次，等待泵的最后一次排干，裁剪环，释放等待方，然后投递一次带逐监听器隔离的 `settled` 事件，再跟上环的最终 `output` 信号。
- **销毁永不死锁。** 抛出的取消会强制失败记录并报告可能的孤立工作，而不是让释放停滞。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`LocalJobRegistry`、准入、生命周期、销毁 |
| [`src/events.ts`](src/events.ts) | 按 scope 分层的事件路由：`{ owner }`、`{ owners: 'all' }` 与 `{ owners: 'scope' }` 订阅 |
| [`src/ring.ts`](src/ring.ts) | 每个任务的有界输出环：追加、保留裁剪、按偏移读取 |
| [`src/pump.ts`](src/pump.ts) | 注册表拥有的拉取泵：每个任务一个定时器，结算前最后一次排干 |
| — | 不发布运行时不变式伴生入口；事件协议与事件对读取的检查位于 `@deepseek-ai/dsh-jobs/invariant`。此提供方的准入决策使用私有配置，并且必须在后端启动器运行前失败；当前生产方由 `LocalJobRegistry.start()` 同步执行该决策。发布后再重复聚合只会向 companion 暴露私有配置，也无法验证失败发生在启动前。 |

### scope 分层

`attachController` 与 `{ owners: 'scope' }` 订阅注册到调用上下文所在的 scope 层；`{ owner }` 与 `{ owners: 'all' }` 订阅不带 scope。控制器问题（`servesOwner`）与带 scope 的投递走同一条链：先是全局层，再沿所有者的链逐层。注册是无名 token，因此重复标签仍可独立释放。

### 准入与结算

`activeJobCount` 按精确所有者或共享无主桶统计权威记录。`settle` 只记录一次终止结果（把记录下来的 kill 原因合并进 `killed` 的 detail），清除进度行，把环裁剪到结算保留量（保留模型游标尚未消费的全部字节），解析每个等待方，然后发出带原因的 `settled` 与环的最终 `output` 信号。原因在 `JobRegistry.kill` 之后为 `kill`，在所有者或服务取消之后为 `teardown`，否则为 `producer`；`dsh-tool-jobs` 据此跳过没人能读的通知。

### 销毁

所有者释放（`disposeOwned`）会取消该所有者的任务、等待其结算、移除其记录，并逐条宣布移除——这是任何逐任务记录都无法表达的可见集变更。服务释放（`disposeAll`）会取消所有存活任务、等待结算、移除每条记录（逐条宣布移除，让挂载在服务之外的订阅者丢掉它的行），然后分离跨 fiber 的所有者清理 effect。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从注册表约定逐步进入模型侧控制与设计记录。

- [后台任务运行时子系统](../../../docs/subsystems/jobs.zh.md)——任务类型、投影字段与 `ctx.jobs` 的 Cordis 接口面。
- [jobs 组映射](../README.zh.md)——同级组页面及其包表格。
- [注册表约定](../jobs/README.zh.md)——本包实现的抽象 `ctx.jobs` 服务。
- [模型侧任务控制](../tool-jobs/README.zh.md)——`job_output`、`job_list` 与 `job_kill` 工具及完成通知。
- [通用长时间运行工具运行时 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)——后台任务运行时背后的设计。
- [任务注册表 seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md)——按所有者隔离的注册表约定及其理由。

-----

<a id="model-experience"></a>
## 模型体验

通过生产方插件与 `dsh-tool-jobs` 间接影响模型，注册表后端把全部模型渲染委托给它们。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表何时不合适。它们是当前包约束，不是任务积压。

- **任务只存在于进程本地**——记录会随 harness 进程终止而消失；持久或跨重启执行需要一个单独实现该 seam 的后端。
- **静默无效的取消可能使销毁停滞并持续占用容量**——如果 `cancel` 返回后始终未结算 `done`，注册表就无法将其与缓慢停止区分开；该任务会在服务剩余生命周期内持续占用一个桶名额，只有显式抛出异常才能安全地强制标为失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
