---
description: "面向模型的 bash 工具，供选择、配置或排查一次性命令执行、后台任务与沙箱升权的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-bash

[English](README.md) | 中文

## 概述

`dsh-tool-bash` 让 agent（智能体）运行一次性 `bash` 命令，并接收 stdout、stderr 与退出标记。每次调用都使用全新 shell，因此 cwd、变量和函数不会保留；`run_in_background` 可启动长时间运行的工作，agent 能用 `job_output` 检查、用 `job_kill` 停止。命令会收到受管 `DSH_*` 环境；沙箱拒绝后，可携带更宽的 `sandbox_permissions`、一句 `justification` 并经用户批准重试一次。非零退出会作为结果报告，因此由 agent 决定如何响应；请使用 `dsh-bash-local` 或 `dsh-bash-sandbox` 等执行器，并加载 `dsh-shell-env`。

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

在 agent 需要运行 bash 命令的任何组合中加载本插件：一旦挂载执行器提供方与 `dsh-shell-env` 注册表，它就注册 `bash` 工具，并在 `tools`、`shell`、`systemPrompt` 与 `shellEnv` 服务就绪之前保持等待。

### 最小配置

常用路径是执行器提供方、环境注册表与本工具；当 agent 需要后台运行命令时，再添加任务运行时。

```yaml
- name: '@deepseek-ai/dsh-bash-local'
- name: '@deepseek-ai/dsh-shell-env'
- name: '@deepseek-ai/dsh-tool-bash'

# Optional: background jobs
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
```

唯一的配置字段用于开关后台支持。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enableRunInBackground` | `true` | 暴露 `run_in_background`；为 `false` 时拒绝强制后台调用 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-bash)是每个受支持字段及其 JSDoc 的穷尽式真源；生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bash)携带完整参数 schema。

### 运行命令

工具执行 `bash -c <command>` 并返回合并后的输出。命令每次调用都运行在全新 shell 中，因此状态从不保留——请传 `workdir` 而不是 `cd`。非零退出以 `[exit code: N]` 报告给 agent 解读，而不是作为工具错误抛出。主动语态的 `description`（5–10 个词）在 UI 中标注该调用；`timeoutMs` 覆盖执行器的默认值与上限。超出执行器流上限的输出会被截断为尾部，完整输出保存到 spill 文件并报告其路径。

<a id="running-long-commands-in-the-background"></a>
### 后台运行长时间命令

传入 `run_in_background: true` 会准入任务并立即返回 job id；限制准备可能仍在进行，且不设后台执行超时。进程可用前输出为空。任务取消会中止准备并停止随后返回的进程；启动失败使已准入任务以失败状态结算。agent 用 `job_output` 读取输出（除非 `wait: true`，否则非阻塞）、用 `job_list` 列出任务、用 `job_kill` 停止任务；完成的任务会在会话内通知拥有它的 agent。后台支持需要挂载通用任务运行时（`dsh-jobs-local`）及其控制工具（`dsh-tool-jobs`）。

### 沙箱执行与升权

当已挂载的执行器约束命令（例如 `dsh-bash-sandbox`）时，被阻止的文件操作会报告为 `[sandbox: file access denied under <mode> mode]`——这是策略拒绝，不是命令失败。模型随后可以在同一轮次中用 `sandbox_permissions`（满足需要的最窄更宽模式）与一句 `justification` 重试完全相同的命令一次；该重试引发的审批提示就是用户同意的方式。升权绝不能预先推测：没有真实拒绝依据的请求，或没有严格宽于当前模式的请求，都会直接失败且不执行任何操作；被拒绝的升权对该命令即为最终结果。

### 可能出什么问题

没有执行器提供方的组合永远不会激活该工具。没有任务运行时的后台调用会以 `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs` 失败；没有沙箱执行器时的 `sandbox_permissions` 会以 `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)` 失败。`enableRunInBackground: false` 会移除该参数，并在执行时拒绝强制后台调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **shell seam 的模型侧消费方。** 本工具是 bash 能力的消费方角色：它注册 `bash` schema、渲染结果并解析每次调用的策略，进程机制归执行器 seam 所有。
- **请求只来自命名参数。** 工具从不暴露 `stdin`、`env` 或 `stdoutMaxBytes`；它只用命令／workdir／超时／信号字段加上注册表收集的 `dshEnv` 构建每个请求，因此模型提供的键无法替换受管值。
- **非零退出只报告、不失败。** 只有基础设施故障（spawn 错误、中止）才会作为工具错误暴露；模型解读退出码与标记。
- **后台工作归任务运行时。** 后台调用把进程句柄注册到 `ctx.jobs`；job id、所有权、完成通知与释放都是运行时的职责，本工具只把 bash 退出与沙箱事实映射为任务输出。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、提示词区段、参数校验、升权、请求组装 |
| [`src/background.ts`](src/background.ts) | 管理异步 shell 准备，并将进程结算映射为任务结果 |
| [`src/render.ts`](src/render.ts) | 模型侧结果文本：流、标记、截断通知 |
| — | 不发布运行时不变式伴生入口；环境注册表在每次变更和读取时校验所有权及收集值，且不发布可供伴生入口交叉核对的独立快照；执行关系由能力 seam 负责。 |

### 请求解析

工具在 `ctx.shell.resolve()` 运行前解析 workdir：显式的相对 `workdir` 相对会话 cwd 解析，沙箱策略的规范化 workspace root 优先，使约束与启动使用同一身份。沙箱策略通过 `ctx.sandboxPolicy` 按调用解析；升权请求在任何执行前经由 `ctx.approval`，若执行器会约束命令却没有挂载策略服务，工具在加载时失败。

### 渲染故事

结果文本为 stdout，然后是带标记的 `[stderr]` 区段，再是条件标记：截断通知、沙箱拒绝（组合声明升权时附带同轮次升权提示）、超时、信号与退出码——每个占一行。退出标记同时充当 UI 卡片的退出状态 pill：`dsh-shell` 共享的 `parseExitStatus` 会从输出体中消费它，因此回放显示 pill 而不重复标记。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 shell 家族逐步进入执行器 seam、任务运行时，以及行为背后的决策笔记。

- [shell 包映射](../README.zh.md)——bash 能力家族及其角色。
- [Bash 执行器子系统](../../../docs/subsystems/shell.zh.md)——请求／spec 词汇、结果与后台进程。
- [shell-env](../shell-env/README.zh.md)——每次调用都会收到的受管 `DSH_*` 环境。
- [tool-jobs](../../jobs/tool-jobs/README.zh.md)——后台运行的 `job_output`、`job_list` 与 `job_kill` 控制。
- [沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)——升权与模式切换的理由。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bash)——`bash` 参数 schema 的确切内容。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-bash)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

以下 bash 指引会以第一方顺序值 1000 出现在该插件注册作用域内的每次请求中。策略归属方通过其缓存安全的运行时上下文贡献当前沙箱状态，而不修改本区段。按作用域实施的工具限制可以隐藏 schema，却不会移除这个独立注册的区段。

##### Bash 指引

```markdown
Check the [exit code: N] marker on every bash result; investigate failures before moving on.
```

#### Token 影响

插件激活期间，每次请求都会产生少量固定的输入 token 开销，不随沙箱模式或模式切换而变。

#### KV Cache 影响

只要注册作用域与提示词文本不变，前缀就保持稳定。插件激活或释放可能使从该提示词区段起的复用失效；沙箱模式切换不会。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`bash` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bash)。仅当本生产方启用 `run_in_background` 时，该字段才会出现；仅当已挂载执行器声明支持沙箱时，`sandbox_permissions` 和 `justification` 才会出现。按 agent 作用域限制工具可以移除该 agent 的定义。

#### Token 影响

工具可见的每个请求都会产生固定 schema 开销；沙箱支持会增加升权字段及其条件说明段落。

#### KV Cache 影响

只要可见性、后台支持与执行器沙箱能力不变，前缀就保持稳定。限制、配置或执行器发生变化时，可能从首个变化的工具定义开始使复用失效。

### 前台结果

#### 模型看到什么

renderer 输出依数据而定的 stdout 尾部，再输出可选的 `[stderr]` 和 stderr 尾部。没有输出时，它精确输出 `(no output)`。条件行精确为 `[output truncated; full output: <path-or-(unavailable)>]`、`[sandbox: file access denied under <mode> mode]`、`[timed out after <timeoutMs>ms]`、`[killed by signal: <signal>]` 与 `[exit code: <exitCode>]`；沙箱升权与 runner 故障行原文列于 [`dsh-bash-sandbox`](../bash-sandbox/README.zh.md)。

#### Token 影响

调用前的结果 token 为零。每条流的输出有界，每个已输出行则会保留在历史中，直至压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 后台任务上下文与结果

#### 模型看到什么

启动会精确返回 `started background job <jobId>`。本生产方会向通用任务运行时提供增量进程输出、可选的 `[some output was dropped from memory; full output: <paths-or-(unavailable)>]`、沙箱事实，以及 `exit code: <exitCode>` 或 `signal: <signal>` 等终止详情。[`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md) 负责模型可见的状态行、完成通知、列表和取消响应。

#### Token 影响

启动确认很短且会保留；收集到的输出依数据而定，并受执行器流缓冲区限制。消费式读取不会重复先前输出。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 工具错误

#### 模型看到什么

验证与策略失败统一为 `Error: <message>`。本包的稳定消息包括 `invalid command: expected a non-empty string`、`invalid description: expected a non-empty string`、`invalid timeoutMs: expected a positive number, got <value>`、升权配对失败、`run_in_background is disabled for this deployment (enableRunInBackground: false)`、`background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`、`sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`、审批不可用／拒绝／取消变体，以及 `tool call aborted`。

#### Token 影响

只有失败调用会增加这些保留 token；升权被拒时命令不会运行，因此不会添加命令输出。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适或需要特别小心。它们是当前包约束，不是任务积压。

- **回放的退出 pill 从结果文本解析**——输出最后一行恰好是 `[exit code: N]` / `[killed by signal: …]` 时，会话回放会显示错误的 pill 并从卡片正文丢失该行，因为解析把它当作要消费的标记；这是仅影响显示的已知残留。
- **`bash` 工具不参与 `timeout-policy` 预算**——它保留执行器自有的 `BASH_TIMEOUT` 路径，见[工具调用超时策略 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-07-tool-call-timeout-policy.zh.md)。
- **后台进程没有执行器超时**——工作不再需要时，调用方必须使用 `job_kill`，或依赖持有者／服务的释放。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
