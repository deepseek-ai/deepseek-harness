# Agent Note: 产品 one-shot subagent 使用通用后台 Job

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-product-subagent-one-shot-background-tasks.md) | 中文

## 问题

Codex 与 Claude Code 提供方已经能够运行一项自包含任务并返回一个最终回答，而 `dsh-tool-subagent` 也已经能够把任意 one-shot 提供方接入通用后台 Job 运行时。随附产品工具行禁用了这条路径，因此即使委托与 agent 的下一步操作彼此独立，agent 也只能等待产品回答。

公开后台执行不得增加产品会话、产品专属作业状态、另一取消责任方或另一结果协议。同一个提供方运行必须继续负责一个原生进程或 query 和一个最终回答，而现有作业注册表继续负责 id、收集、取消、owner 清理与完成通知。

## 决策

生产 `dsh` 不安装可选产品提供方。选择启用产品集成的 Profile 会安装所需的 `dsh-subagent-codex` 或 `dsh-subagent-claude-code` 包，并在 host plane（宿主平面）挂载所需的提供方实例。`standard`、`code` 与 `cordis` Agent Preset 使用 `backgroundMode: one-shot` 配置相应的休眠工具行；删除某一行的 `disabled` 字段后，现有可选参数 `run_in_background` 会向由该 preset 组装的 agent 公开。省略该参数或传入 `false` 时会在前台等待；显式传入 `true` 时会在同步完成 Job 预检与登记后返回由父级拥有的 Job id，而不会等待提供方启动或完成。

[命名实例决策](2026-08-18-product-subagent-named-instances.zh.md)允许两个产品分别拥有多个配置项。每个新增宿主提供方配置项都有独立的 `providerName`，每个公开的 preset 工具配置项都通过 `provider` 绑定该名称并保持唯一的 `toolName`；前台或后台调度选择不会限制实例数量。

[通用 one-shot 后台适配器](2026-07-08-background-subagent-tasks.zh.md)负责后台登记与结算。它会启动同一个 [`SubagentRun`](2026-06-21-subagent-capability-seam.zh.md)，让 Job 自有的取消信号覆盖提供方启动与执行，等待 `run.result` 和 `run.dispose()`，把终态结果与可选安全诊断映射进 Job，并由 `job_output`、`job_list`、`job_kill` 与现有完成通知公开该状态。[产品提供方决策](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)继续负责原生协议、答案选择、本地取消与进程树完全停稳；[非交互权限决策](2026-08-15-product-subagent-noninteractive-permissions.zh.md)负责各产品提供方的 Profile 配置与诊断生产。

本调度决策不新增提供方配置、服务接口、事件、协议字段、持久化格式或产品标识符。提供方可以独立定义自己的 Profile 配置；前台与后台的区别仍然只在于由哪个现有消费方等待同一个 one-shot 运行。

### 归属与生命周期

```text
product tool call
  -> omitted / false: tool call waits -> final answer or error -> run disposal
  -> true: Job preflight + owner cleanup
           -> starter begins provider startup under Job-owned signal
           -> Job record/id published and returned (startup remains pending)
           -> provider result + run disposal -> Job settlement + notice
                                              -> job_output reads / job_kill cancels
  -> parent disposal: Job owner cleanup cancels -> run disposal -> process exit
```

| 事实或资源 | 责任方 | 产品工具职责 | 可观察结果 |
| --- | --- | --- | --- |
| 产品提供方安装与登记 | 显式 Profile | 安装可选提供方包，并在 host plane 挂载所需的命名实例 | 提供方名称可用，但不会让每次生产 `dsh` 安装都包含该包 |
| 产品选择与公开 | Agent Preset | 把一个固定工具名绑定到一个固定提供方 | 启用一行只会公开对应产品工具 |
| 前台或后台选择 | `dsh-tool-subagent` | 按 `one-shot` 策略解析 `run_in_background` | 省略参数时在前台运行；显式传入 `true` 时返回 Job id |
| Job id、状态、输出、取消与通知 | `ctx.jobs` 与 `dsh-tool-jobs` | 登记并展示现有 one-shot 运行 | 通用作业工具为准确父级收集或停止运行 |
| 原生结果、可选诊断与进程完全停稳 | 产品提供方与 `dsh-subprocess` | 产生一个最终结果并释放一棵进程树 | Job 结算与前台返回消费同一结果，且都会等待资源释放 |

## 发布组装

生产 base 不让两个可选产品提供方进入依赖闭包。选择启用产品集成的 Profile 会安装所需包，并在 host plane 挂载所需的提供方实例。每个完整 preset 让两个产品工具行保持禁用，并把通用 Job 控制工具贡献到自身 agent 作用域；base host 负责共享 Job 注册表。Profile 提供方实例存在后，用户复制一个 preset，再从对应产品行删除 `disabled`；组装期间不会启动产品进程。

独立自定义组装若启用 one-shot 后台执行，就必须同时提供产品提供方与完整通用 Job 能力：由 `dsh-jobs-local` 充当 Job 提供方，由 `dsh-tool-jobs` 充当面向模型的消费方。基于 `dsh-base` 的 Profile 已具备 Job 能力，只需在启用 preset 工具行前新增可选产品提供方。没有 Job 运行时的产品工具仍可在前台执行，但显式后台请求会在现有 Job 预检中失败，不会发布无法收集的 id。

ACP 产品组装使用相同的固定产品行与通用作业控制工具。其无密钥 schema 快照会为每个已启用产品工具公开 `description`、`prompt` 和可选的 `run_in_background`，而不会调用 Codex、Claude Code 或外部模型。

## 验证

Web 组装测试会从仓库 examples 依赖锚点显式挂载两个可选提供方，再启动四种用户 preset 变体——不启用产品、只启用 Codex、只启用 Claude Code，以及同时启用两者——并检查每个已启用产品工具都会与 `job_output`、`job_list` 和 `job_kill` 一起公开 `run_in_background`。两个由包负责的 Loader 组装会在空 `PATH` 下运行，检查相同 schema 与控制工具，并证明显式加载提供方不会启动产品进程。ACP 无密钥快照会固定显式组装后的产品 schema，而现有 `dsh-tool-subagent` 与作业测试套件会固定前台默认值、Job 登记、最终输出收集、共享诊断呈现、取消、完成通知、owner 资源释放与提供方资源释放。两个真实产品提供方测试套件还会分别证明各自的原生权限失败先进入同一个共享结果，再由任一调度路径消费。

## 曾考虑的替代方案

**让产品工具继续只支持前台运行。** 这种方案保留最小 schema，却会阻止 agent 调度独立产品工作，即使通用 one-shot Job 适配器已经负责所需生命周期。

**让产品委托默认在后台运行。** one-shot Job 需要后续收集，这不同于拥有自身持久会话 id 与结算交付的可续接子级。前台继续作为兼容默认值，后台继续作为显式调度选择。

**让 Codex 或 Claude Code 原生会话状态负责后台生命周期。** 这会在通用作业注册表之外建立提供方专属 id、状态、取消与恢复语义。提供方继续只产生 one-shot 结果，并把原生 id 保持为私有事实。

**增加产品专属 output、wait 或 kill 工具。** 独立控制工具会复制通用作业协议，并为每个提供方教授不同的收集工作流。现有 `job_*` 工具已经覆盖所需操作。

**同时增加可续接产品会话。** 恢复、后续交互、进度与持久化产品会话需要新的产品约定和生命周期归属。本决策只公开已经实现的 one-shot 后台路径。

## 后果

agent 可以在 Codex 或 Claude Code 处理独立 one-shot 任务时继续推进其他工作，随后通过其他后台 producer 共用的 Job 控制工具收集最终回答或取消运行。若失败结果提供了安全的提供方诊断，前台与一次性后台消费方会呈现同一内容。

每次产品委托仍会启动一个全新的原生进程或 query，把最终 assistant 文本作为唯一 assistant 载荷，并以提供方资源释放和整棵进程树退出结束。失败结果可以另行携带安全诊断。后台调用还会额外公开通用 Job id、状态、完成通知以及收集或取消结果。后台 Job 仅存在于当前进程且由父级拥有：它不会在父级资源释放后继续存活，不会公开产品中间活动，也不会让产品对话变得可恢复。只有 Profile 显式安装产品集成时，生产安装才承担对应成本；公开后台参数的任何组装还必须让通用 Job 提供方与控制工具保持可用。
