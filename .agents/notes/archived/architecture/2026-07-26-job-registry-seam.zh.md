# Agent Note: 任务注册表是一个能力 seam（`dsh-jobs` / `dsh-jobs-local`）

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-job-registry-seam.md) | 中文

## 问题

[后台任务运行时](2026-06-20-generic-long-running-tool-runtime.zh.md)交付时把 `JobRegistry` 做成了单个具体包：`@deepseek-ai/dsh-jobs` 既拥有每个生产方和控制器面向编程的 `ctx.jobs` 约定，也拥有进程内 Service Provider（内存存储、结算簿记、所有者清理 effect、拆除）。这种捆绑重新耦合了仓库[能力 seam 规则](2026-06-13-capability-seams.zh.md)本要分离的两种变化速率：一旦替换注册表的存储或生命周期后端，被搅动的就是同一个包，而生产方（`dsh-tool-bash`、`dsh-tool-terminal`、`dsh-tool-subagent`）、控制器（`dsh-tool-jobs`）和 `JobKindMap` 扩展方正是从这个包导入类型与 `ctx.jobs` API。harness 中其余每项可替换能力——bash、pty、fs、skill（技能）、subagent、web、会话持久化——都已具备 Service Definition / Service Provider / Consumer 三分；任务注册表曾是仅剩的 `core` 模式例外，仅由一条 `TODO(job-service-backend)` 注释把守。

## 决策

`jobs/` 如今是一个 bash 三件套形态的三包能力家族：

- **`@deepseek-ai/dsh-jobs`（Service Definition）**——抽象的 `JobRegistry extends Service`，拥有 `ctx.jobs`、九个方法的约定（`start`、`list`、`get`、`read`、`kill`、`wait`、`onJobDone`、`onJobsChanged`、`attachController`）、全部词汇类型（`JobId`、`JobKindMap`、`JobStart`、`JobHooks`、`JobOutcome`、`JobSnapshot`、`JobRead`、`JobDoneListener`），以及快照不变式配套插件。类级 JSDoc 陈述了每个 Service Provider 都必须兑现的语义：注册的存续期长于生产方与控制器的 fiber，有所有者的访问以会话为界，结算遵循首次结果优先且监听器错误被隔离，并且当没有任何已附加的任务控制器服务于 spec 的所有者时 `start` 拒绝启动工作（控制器与监听器按 scope 分层，因此一个进程级注册表能逐所有者地回答这两个问题）。
- **`@deepseek-ai/dsh-jobs-local`（Service Provider）**——`LocalJobRegistry`，即进程内注册表：内存存储、按 kind 划分的 id 计数器、等待方簿记、`TASK_WAIT_TIMEOUT` deadline 代码、所有者清理 effect、强制失败的拆除，以及默认值为 10 且可配置的准入策略。准入从同一组记录中按确切 owner 派生 `running` 加 `stopping` 容量，并为无 owner 任务使用一个共享桶；它不新增公开计数或第二个状态 owner。`dsh-timeout` 依赖与由 Schemastery 管理的 Service Provider 配置都位于此包；Service Definition 包不含任何提供方依赖。
- **`@deepseek-ai/dsh-tool-jobs`（Consumer）**——保持不变；它注入 `'jobs'`，从不导入提供方类型。

各组合在原先加载 `dsh-jobs` 的位置改为加载 `dsh-jobs-local`：`dsh-base`、`sdk-minimal`、各测试 harness，以及工具目录生成器的启动流程。生产方的配置错误诊断信息（「background jobs unavailable: load …」）点名 `dsh-jobs`——即声明缺失的 `ctx.jobs` 服务的 Service Definition 包；Service Definition 包自身的 API（其 README 与直接挂载防线）会指向各 Service Provider，因此当另一个后端日后成为推荐默认时，生产方的消息依旧正确。生产方、`JobKindMap` 声明合并和控制器仍然只导入 `@deepseek-ai/dsh-jobs`。

该 seam 保持进程内约定语义不变：`JobStart.run()` 仍然传入回调和确切的 `Agent` 对象，因此持久化或跨进程后端在能满足此 Service Definition 之前仍有设计工作要做（身份、重启、所有权、观察）。这次拆分把该项未来工作移出了每个 Consumer 的依赖图；它并不预先设计后端。

## 曾考虑的替代方案

**在第二个后端出现之前保持具体服务（维持现状）。**这正是运行时 Agent Note 当初的立场：在第二个 Service Provider 出现前抽取 Service Definition，可能固化错误的边界。该方案落选，因为这条边界已不再是臆测：九个服务方法及其语义自引入以来在每一次生产方集成中都保持稳定，它们正是 `dsh-tool-jobs` 与各生产方已经面向编程的那套接口，而且仓库约定默认将可替换能力拆成三个包。剩余风险（持久化后端可能需要变更约定）不因这次拆分而改变：无论拆分与否，这类变更都会落在 Service Definition 包里；而若维持现状，它们还会连带搅动每个 Consumer 的提供方依赖。

**在单个包内仅抽取 Service Definition（在具体类旁导出一个抽象类）。**否决，因为它在运作层面并未分离任何东西：Consumer 依然依赖携带 Service Provider 及其依赖项的那个包，而替换后端若不把本地 Service Provider 纳入自身依赖图，就仍然无法发布。在这里，包边界才是独立演进的单位。

**拆出 `types.ts` 但让服务保持具体。**基于同样的理由否决：类型并不是完整能力，`ctx.jobs` Service Definition 及其方法约定才是。生产方需要的是服务键和语义，而不只是类型形状。

## 后果

换来的是：任务注册表如今与全仓库通行的 seam 形态一致；持久化、远程或带插桩的注册表将是一个实现九个抽象方法的同级 Service Provider，这样的注册表落地时，任何生产方、控制器或 `JobKindMap` 扩展方都无需改动。Service Definition 的 README 陈述约定；生命周期簿记方面的事实归 Service Provider 的 README 所有。注册表行为测试套件（所有者清理、结算、等待、拆除）随 `dsh-jobs-local` 存放；Service Definition 包保留一个桩子类（stub subclass）测试，固定 `ctx.jobs` 下的注册行为与单一服务的重复注册行为，外加基于探针的不变式测试套件。

代价是：多出一个包，即多一份 manifest（元数据清单）、tsconfig、README 与不变式配套插件；同时各组合必须点名 Service Provider 包。`abstract` 在运行时会被擦除，而这个包名过去正是可挂载的具体注册表，因此直接挂载 Service Definition 时，其构造函数会明确报错——一条陈旧的组合配置行会在加载时得到「load a Service Provider such as @deepseek-ai/dsh-jobs-local」，而不是一个未完整注册的 `ctx.jobs` 在远离错误配置处才失败。
