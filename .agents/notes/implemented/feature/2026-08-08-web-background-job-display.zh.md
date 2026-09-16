# Agent Note: Web 后台任务展示

Status: implemented

[English](2026-08-08-web-background-job-display.md) | 中文

## 问题

`ctx.jobs` 已经承载了 harness 在后台启动的全部长时工作——`bash`、`pwsh`、`pty-send`，以及一次性后台 subagent——但它唯一的读者是模型。[`dsh-tool-jobs`](../../../../packages/jobs/tool-jobs/README.zh.md) 暴露了 `job_list`、`job_output` 和 `job_kill`，除此之外没有任何东西观察这个注册表。

于是 Web 端的人类看不到构建正在跑，分不清一个任务是已经完成还是卡死，也无法把它停掉。唯一的痕迹是 transcript 里更早某处那张打印了 job id 的 `run_in_background` 工具卡片，而那张卡片此后再也不会更新。

会话 header 本来就是每会话后台活动的落点：[`dsh-client-ui-subagent`](../../../../packages/client/ui-subagent/README.zh.md) 把 subagent 目录贡献到 `conversation.session.header.actions`。位置没有争议。缺的是任何一条把任务状态送到浏览器的通道。

## 决策

任务状态以**每会话一帧的整份 control 快照**到达浏览器，在注册表每一个会改变该会话可见内容的提交点推出。客户端保持一份 last-wins 镜像，由一个 header 入口渲染。没有 RPC，没有轮询，客户端不需要任何过期状态管理。

本次只交付列表。每个任务的流式输出与人类发起的中断是各自独立的阶段，而通道的形状让两者都不必推翻它。

### 线路形状

Session Controller control 流中的一帧：

```ts ignore-check
| { type: 'jobs'; sessionId: SessionId; jobs: SessionJob[] }
```

`SessionJob` 是浏览器安全类型，与其他 Session Remote 约定一起由 [`packages/api/session-controller/src/types.ts`](../../../../packages/api/session-controller/src/types.ts) 拥有：

```ts
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'

export interface SessionJob {
  id: JobId
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}
```

`JobId` 取自不依赖 cordis 的 [`@deepseek-ai/dsh-jobs/brand`](../../../../packages/jobs/jobs/src/brand.ts) 叶子——与 `api/subagents.ts` 已经在用的 `@deepseek-ai/dsh-llm/brand` 导入是同一种安排，因为 `dsh-jobs` 根出口会牵到 `dsh-agent`，即便只作类型也无法被客户端程序触及。和本仓库其他每一个非根子路径一样，它带有显式的 `tsconfig.base.json` `paths` 条目；没有这一条，Typert 分析器会把该 specifier 解析到 `lib/types/` 并判定该引用未被导出。

线路上的 `kind` 是 `string` 而非 `JobKind`。kind 映射由生产者插件按声明合并扩展，客户端构建无法枚举这个闭集；遇到无法识别的 kind，呈现层走一条有文档的默认分支。

`JobSnapshot` 的三个字段被刻意省去：`ownerSession`（帧的 `sessionId` 已经带了）、`reported`（内部的通知投递位，对用户无意义），以及 `outputLimitBytes`（生产者拥有的模型呈现策略）。

这一帧带整份快照而非增量，因此启动、中断、结算、重连，以及第二个浏览器标签页，全都通过同一个权威值收敛。一个会话的任务集是个位数，帧很小。

### 任务注册表变更订阅

`JobRegistry` 拥有一个观察方法：

```ts ignore-check
abstract onJobsChanged(listener: JobsChangedListener): () => void
```

它在每一个会改变 `list(owner)` 返回内容的提交点**之后**触发：`start()` 末尾的注册、`kill()` 里转入 `stopping`、结算，以及 `disposeOwner()` 执行的移除。`owner` 为 `undefined` 表示一个无主任务发生了变化，因而每一个调用方的视图都变了。

监听器按 owner 而非按任务分粒度。唯一的消费方推的是整份快照，逐任务记录到手即弃——而且逐任务的订阅根本无法表达 owner 销毁时的移除，除非发明一个别处都不需要的墓碑状态。

`onJobDone` 不是它的子集。后者按 first-wins 语义投递终态记录和确切的 owner `Agent`，`dsh-tool-jobs` 把这套语义与 `reported` 绑在一起；`onJobsChanged` 是纯观察，不含任何投递含义，也不把任何东西标为已上报。监听器抛错被包住且从不 await，与 `onJobDone` 一致，每次注册都是调用方 fiber 上的 effect。

服务销毁刻意什么都不通告。每个 `onJobsChanged` 注册都是注册表自身 fiber 上的 effect，等到 teardown 清空 store 时监听器早已消失；观察者通过自己的销毁而不是一份最终空集来得知注册表离开了。

### Session Controller 载体

[`SessionControlController.control()`](../../../../packages/api/session-controller/src/control.ts) 先发出一份完整的 Host 范围 baseline，再发送后续 `jobs` 替换帧。每次物理重连都会打开新一代流，因此客户端会先替换进程本地镜像，再应用后续变更。

载体守着四条规则：

- **绝不 resume。** 变更推送用监听器给出的确切 `Agent` 调 `jobs.list(owner)`，即使该 owner 的 scope 正在拆除、按 id 查找已经查不到，它依然正确。baseline 则读 `ctx.jobs.list(ctx.agents.get(session.id))`，没有 live Agent 的 Session 正确地只得到无主任务。两条路径都不调用 [Session Controller Agent 解析器](../../../../packages/api/session-controller/src/agent.ts)，因为列出任务绝不能复活用户随手划过的 Session。
- **无主变更要扇出。** `owner` 为 `undefined` 时向每一个已挂接 Session 推一份新快照，因为无主任务对所有调用方可见。
- **保持可选。** 载体读 `ctx.get('jobs')`。没有挂注册表的组合报告空任务集，客户端也就不渲染入口。
- **显式表示空集。** opening baseline 为每个已挂接 Session 提供一项，包括 `[]`；后续变更清空一个列表时也会推送 `[]`。客户端因此可以把空集归一化为缺失键，而不会保留陈旧行。

### 客户端镜像

`SessionListState` 带有 `jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>`，由 `SessionManager` 拥有，按 last-wins 从帧折叠而来；被清空的集合存为缺失的键，使「缺失」与 `[]` 成为同一种表示。

它放在列表镜像而不是 `Session` 上，有三个理由：header 入口本来就通过 `useSessions` 读列表状态；没有 composer 行为依赖任务；将来侧栏加指示器时不必再开第二条通道。

两个替换点让它保持诚实。每一代 control 流都会先清空完整任务镜像，再安装新 baseline 中的非空集合。`api-session/removed` 事件也会删除该 Session 的条目，不依赖任务注册表 disposal 通知与它之间的顺序。

### header 入口

[`@deepseek-ai/dsh-client-ui-jobs`](../../../../packages/client/ui-jobs/README.zh.md) 在 `conversation.session.header.actions` 注册一个条目，排在 subagent 目录之后。呈现契约归它自己的 README；值得记在这里的决策是：会话没有任务时控件根本不渲染；活跃角标为零时省略，让只剩历史的会话保留一个安静的入口；终态行保持可见，因为失败任务的 `detail` 是其失败唯一可读之处。

因此一个运行中的一次性后台 subagent 会同时出现在那里和 subagent 目录里。两者回答不同的问题——目录负责进入子会话的 transcript，而这个列表是中断能力唯一可能附着的句柄——在这里屏蔽 `kind: 'subagent'` 会让中断那一期恰好对这批任务没有入口。

### 刻意不做的事

**没有任何 Web 路径调用 `ctx.jobs.read()`。** 它消费唯一的输出游标，浏览器读一次就悄悄拿走了模型 `job_output` 永远看不到的字节。这该是一条有测试兜底的不变量而不是一条约定，因为它的故障在调用点完全不可见。

**不做中断。** 那一期欠一个 seam 目前没有回答的决策：`kill()` 会把终态投递标为已上报，所以照 `kill()` 契约写出来的人类中断，会让模型一直以为它的任务还在跑。

**帧上不带输出水位。** 输出那一期的增量通道才是锚点字段该出现的地方；现在加就是一个没有读者的字段。

## 备选方案

**信号帧加 RPC 拉取，即 subagent 目录的形状。** 推一个无 payload 的 `jobs-changed` 信号，防抖后用一元 RPC 重读权威状态。subagent 目录就是这么做的，代价在 [`SessionManager`](../../../../packages/api/session-controller/src/client/sessions/manager.ts) 里一览无余：`catalogInflight` 做单飞行、`catalogStale` 在成员帧落于请求中途时补一次尾拉、`updateCatalogActivity` 既就地打补丁又往在途请求里写一份好让比帧更旧的响应被覆盖、`parentAvailableOverride` 重放一个过期的 `false`，还有重连时逐一重拉每个打开的目录。这套装置之所以存在，是因为目录的权威被劈成两半——持久血缘来自投影，活跃度是响应时刻的采样——而任务没有持久的那一半，不该继承这份复杂度。它还恰好在输出那一期最在意的时刻失效：任务结算，输出流立即关闭，状态却要等防抖加一次往返才到，那段窗口里 UI 显示一个流已死的运行中任务。

**只在弹层打开时轮询，不改 seam。** 最省事，也是唯一不碰 `JobRegistry` 的选项。它无法在不常驻轮询的前提下支持触发器上的常驻计数，而后面两期反正都需要一条真正的变更订阅，所以它省下一周又还回去。

**基于持久任务事件的 session-projection 单元。** 投影单元在已提交的会话事件上折叠，所以这条路要先让任务生命周期变持久——`job/started` … `job/settled` 作为一对独立的开合括号，由最后一个 [`session/end-seed`](../../../../packages/core/session/src/types.ts) 把未配对的开括号标为死历史，与 compaction 括号已有的做法完全一致。它在客户端确实更省：`dsh-tool-todo` 用十五行的单元展示了整套模式，而现成的 `session/projection` 帧、history-tail 块和持久化 checkpoint 缓存本可以承载这批数据，无需新线路面、无需载体订阅、无需 manager 状态。否决它，是因为这要拿一次持久格式变更去换一个浏览器列表，而且它并不能延伸到最需要它的那一期：[`spill/`](../../../../packages/spill/README.zh.md) 的存在正是为了让超大工具输出留在日志之外，所以流式任务输出无论如何都不能骑在持久事件上。如果持久任务历史将来凭自身价值站得住，本设计不阻挡重新考虑它。

**复用 `dsh-tool-jobs` 的 `PublicJobSnapshot`。** 字段几乎就是对的，但它属于面向模型的控制面。浏览器程序从一个 tool 包导入线路类型，会把客户端呈现耦合到面向 prompt 的决策上，并把一个 host-only 包拖进客户端构建。

**并进 subagent 目录做成统一的「活动」面板。** 一个入口而不是两个。否决的理由是 `SubagentCatalogAction` 已经 605 行，其主题是含已结束子会话的持久会话血缘树；进程域的任务是第二套数据模型，身份、生命期和可用动作都不同，而目录的懒展开分支、时长与 token 契约全都要重写才能容纳它们。

**跨全部会话的 host 全局任务列表。**「显示所有运行中任务」的字面读法。否决是因为注册表的鉴权围栏是按 owner 会话的，全局读需要一条新的访问规则，而且全局列表不该出现在某个会话的 header 里——它需要侧栏里自己的位置。本设计没有阻挡后续再加；按会话的帧就是同一批数据。

## 测试

[web e2e 场景](../../../../apps/web/tests/background-job-list.e2e.ts)是端到端的证据，且无需密钥：一次真实的 `run_in_background` bash 调用注册进 `ctx.jobs`，header 的计数与行在没有任何用户操作的情况下出现，通过注册表杀掉该任务后打开着的列表翻到生产者给出的 detail。它断言的是整条投递链路，而不是其中某一层。

在它之下，[`jobs-local`](../../../../packages/jobs/jobs-local/tests/jobs.spec.ts) 钉住变更订阅的全部四个提交点、对抛错观察者的包容，以及显式销毁与 fiber 拆除两条路径上的注销；[`control-jobs`](../../../../packages/api/session-controller/tests/control-jobs.host.spec.ts) 钉住完整 baseline、三次变更推送、被丢弃的内部字段、无主扇出、不 resume 的保证、没有注册表的组合，以及不得消费模型输出；客户端各套件钉住 baseline 替换、last-wins 折叠、缺失键表示、移除清理，以及组件的排序、时长与关闭行为。

## 影响

**漏掉一个提交点会漏行。** 如果 `disposeOwner()` 的移除有朝一日不再触发订阅，客户端会一直留着已经不存在的任务，直到会话消失。整份快照的形状让这件事可恢复而非损坏——下一次正当变更就修好了——但销毁路径是最容易被忘掉的一条，所以它自带测试。

**无主任务的扇出很容易做漏。** 只推给变更 owner 所在的会话，对有主任务是对的，对处处可见的无主任务则是悄悄错的。这个 bug 只会在会创建无主任务的组合里显形，所以载体套件直接覆盖了它。

**UI 的集合不等于注册表的集合。** header 显示的是「一个会话能看到什么」，所以别的会话拥有的任务在这里永远不出现，尽管注册表里有它；而由于注册表是进程本地的，一次重启会清空所有列表，transcript 里那些启动它们的 `run_in_background` 卡片却还在。无主任务是反过来的情形：它们会进入每一个会话的列表，正如 `list(caller)` 对每个调用方都报告它们。

**终态行会堆积。** 注册表把已结算任务留到 owner 销毁，所以一个跑了很多后台命令的长会话会积出长列表。如果真的成为抱怨，给终态尾巴加上限是呈现层改动而非协议改动。

**`stopping` 很少可见。** 只有模型的 `job_kill` 会产生它，所以这个状态会被渲染但在人类中断落地之前很少见到。现在就纳入联合类型，是因为把它留在外面会让那一期变成一次线路变更。

**一个运行中的 subagent 有两个入口。** 这是刻意接受的，且被限制在一次性后台委派这一种情况。如果实际用起来读着像噪声，修法是呈现层的——可以让目录行引用那个任务，而不是让任务列表隐藏这个 kind。

**新增非根子路径必须补 `paths` 条目。** `@deepseek-ai/dsh-jobs/brand` 得先登记进 `tsconfig.base.json`，Typert 分析器才会接受该引用。它的故障表现是一条来自远离改动处的生成器的、令人困惑的「not exported by」错误，所以这个条目是新增子路径的组成部分，而不是优化。
