---
description: "面向模型的 pwsh 工具，供选择、配置或排查 Windows 上一次性 PowerShell 执行、后台任务与沙箱升权的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-pwsh

[English](README.md) | 中文

## 概述

`dsh-tool-pwsh` 为 agent 提供 `pwsh` 工具，通过已挂载的 shell 执行器运行 PowerShell 命令——它是 `dsh-tool-bash` 的 Windows 对应物，逐调用镜像。每次调用都运行在全新 pwsh 进程中，因此状态不会保留；`run_in_background` 把长时间运行的命令变成后台任务。命令是 PowerShell 方言：原生 `C:\...` 路径与 `$env:NAME` 变量，不做方言翻译。每次调用都运行在受管 `DSH_*` 环境中；在沙箱执行器下，工具会教授并执行 Windows 特有的语言模式与命名管道约定。请与 `dsh-pwsh-local` 等 PowerShell 执行器以及 `dsh-shell-env` 插件一起挂载。

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

在 agent 需要运行 PowerShell 命令的任何组合中加载本插件——通常是 `ctx.shell` 由 PowerShell 执行器支撑的 Windows 组合。一旦挂载执行器提供方与 `dsh-shell-env` 注册表，它就注册 `pwsh` 工具。

### 何时选择

当命令必须用 PowerShell 编写——原生路径与 `$env:` 变量——或部署是 Windows 原生时，选择 pwsh 工具。当命令集是 bash 方言时选择 `dsh-tool-bash`；两者之间没有翻译。当工作依赖跨调用状态（cwd、变量）时，持久对应物 [`dsh-tool-pwsh-persistent`](../tool-pwsh-persistent/README.zh.md) 会保持一个按所有者隔离的 shell 存活。

### 最小配置

常用路径是 PowerShell 执行器提供方、环境注册表与本工具。

```yaml
- name: '@deepseek-ai/dsh-pwsh-local'
- name: '@deepseek-ai/dsh-shell-env'
- name: '@deepseek-ai/dsh-tool-pwsh'
```

唯一的配置字段用于开关后台支持。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enableRunInBackground` | `true` | 暴露 `run_in_background`；为 `false` 时拒绝强制后台调用 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-pwsh)是每个受支持字段及其 JSDoc 的穷尽式真源；生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh)携带完整参数 schema。

### 运行命令

工具执行 `pwsh -Command <command>` 并返回合并后的输出。命令每次调用都运行在全新 pwsh 进程中，因此状态从不保留——请传 `workdir` 而不是 `cd`。路径使用原生 Windows 形式，环境变量用 `$env:NAME` 读取。非零退出以 `[exit code: N]` 报告；在 Windows 上，强制终止的命令以 `[exit code: 1]` 结算且没有信号标记，因此 agent 把中断后的裸 exit 1 当作终止而非命令失败。后台运行、输出截断以及 `description`／`timeoutMs`／`workdir` 参数的行为与 `dsh-tool-bash` 完全一致。

### Windows 特有的沙箱行为

在沙箱执行器下，被拒绝的命令会报告 `[sandbox: file access denied under <mode> mode]`，并适用相同的单次升权路径：用 `sandbox_permissions` 加一句 `justification`，经用户审批后重试完全相同的命令一次。工具还会在其描述中教授两条 Windows 受限令牌约定：只读 pwsh 运行在 ConstrainedLanguage 中（`.NET` 静态调用、`Add-Type`、COM 与反射会以 "only core types" 错误失败）；两种受限模式下程序都无法打开命名管道，因此通过管道 stdio 捕获另一程序输出的命令会以 EPERM 失败——请升权该确切命令一次，或重构命令以避免捕获输出。

### 可能出什么问题

没有 PowerShell 执行器的组合永远不会激活该工具，且注入的服务（`tools`、`shell`、`systemPrompt`、`shellEnv`）必须全部存在。没有任务运行时的后台调用会以 `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs` 失败；没有沙箱执行器时的 `sandbox_permissions` 会以 `sandbox_permissions is not available in this composition (no sandboxing executor to escalate)` 失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **`dsh-tool-bash` 的刻意孪生。** 前台与后台执行、受管环境、沙箱升权面以及标记／截断渲染都逐调用镜像 bash 工具，因此其中之一的消费方也能接受另一个的协议形状（[pwsh 工具与执行器 Agent Note](../../../.agents/notes/implemented/feature/2026-08-01-pwsh-tool-and-executor.zh.md)）。
- **PowerShell 方言约定。** 工具约定是 PowerShell：原生路径与 `$env:` 变量，经由 `pwsh -Command` 执行，没有中间 shell。
- **Windows 沙箱事实写进描述。** ConstrainedLanguage 与命名管道约定是 Windows 受限令牌行为；教授它们的条件是「已挂载任意约束执行器」，之所以安全，是因为每个已发布的配对都是 win32-only。
- **非零退出只报告、不失败。** 只有基础设施故障（spawn 错误、中止）才会作为工具错误暴露，与 bash 的故事一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、提示词区段、参数校验、升权、请求组装 |
| [`src/background.ts`](src/background.ts) | 把已结算的后台进程映射为通用任务结果词汇 |
| [`src/render.ts`](src/render.ts) | 模型侧结果文本：流、标记、截断通知（bash 孪生） |
| — | 不发布运行时不变式伴生入口；执行关系归能力 seam 所有。 |

### 渲染与退出标记

renderer 共享 bash 工具的结构与来自 `dsh-shell` 的 `parseExitStatus` 标记约定：干净退出（0、无信号）不产生标记；UI 卡片把退出标记消费为退出状态 pill。Windows 强制终止以 exit 1 结算且没有信号，因此 `[killed by signal: …]` 在那里只存在于 POSIX。`tool:pwsh` 提示词区段（first-party 顺序 1010）教授退出标记约定与「中断后 exit 1」的 Windows 解读。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 shell 家族逐步进入执行器 seam，以及 Windows 行为背后的设计笔记。

- [shell 包映射](../README.zh.md)——bash 能力家族及其角色。
- [Bash 执行器子系统](../../../docs/subsystems/shell.zh.md)——请求／spec 词汇、结果与后台进程。
- [shell-env](../shell-env/README.zh.md)——每次调用都会收到的受管 `DSH_*` 环境。
- [tool-jobs](../../jobs/tool-jobs/README.zh.md)——后台运行的 `job_output`、`job_list` 与 `job_kill` 控制。
- [pwsh 工具与执行器 Agent Note](../../../.agents/notes/implemented/feature/2026-08-01-pwsh-tool-and-executor.zh.md)——为什么工具镜像 bash 工具，以及 Windows 沙箱如何门控其描述。
- [Windows ACL 受限令牌沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)——语言模式与命名管道约定。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh)——`pwsh` 参数 schema 的确切内容。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-pwsh)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

该插件注册 scope 中的每次请求都在 first-party 顺序 1010 处包含以下 pwsh 指引。按 scope 限制工具可以隐藏 schema，却不会移除这个独立注册的区段。

##### Pwsh 指引

```markdown
Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.
```

#### Token 影响

插件激活期间，每次请求都会产生少量固定的输入 token 开销。

#### KV Cache 影响

只要注册 scope 与提示词文本不变，前缀就保持稳定。插件激活或释放可能使从该提示词区段起的复用失效。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`pwsh` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-pwsh)。按 agent（智能体）scope 限制工具可以移除该 agent 的定义。

#### Token 影响

工具可见的每个请求都会产生固定 schema 开销。

#### KV Cache 影响

只要可见性与工具定义不变，前缀就保持稳定。限制或配置变化可能从首个变化的 token 开始使复用失效。

### 前台结果

#### 模型看到什么

renderer 输出依数据而定的 stdout 尾部，再输出可选的 `[stderr]` 和 stderr 尾部。条件行精确为 `[output truncated; full output: <path-or-(unavailable)>]`、`[sandbox: file access denied under <mode> mode]` 加升权提示 `[sandbox: escalation available — …]`（仅在组合声明升权时）、`[timed out after <timeoutMs>ms]`、`[killed by signal: <signal>]` 与 `[exit code: <exitCode>]`（仅非零退出）；空正文渲染为 `(no output)`。

#### Token 影响

调用前的结果 token 为零。输出按流设界，而每行已发出的内容在压缩（compaction）前保留于历史。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 后台结果

#### 模型看到什么

后台启动精确渲染为 `started background job <id>`；随后的读取与状态经由通用 `job_output`／`job_kill` 工具流转，包括内存截断丢弃未读字节时的有损读取 spill 通知。

#### Token 影响

确认是一行固定的短文本；任务输出按每次读取设界。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 工具错误

#### 模型看到什么

验证与基础设施失败统一为 `Error: <message>`。本包的稳定消息包括 `invalid command: expected a non-empty string`、`invalid description: expected a non-empty string`、`invalid timeoutMs: expected a positive number, got <value>`、升权配对失败、`sandbox_permissions is not available in this composition (no sandboxing executor to escalate)`、共享升权失败（未严格加宽／无审批服务／无 agent 可路由／无审批通道／用户拒绝／已取消）、`run_in_background is disabled for this deployment (enableRunInBackground: false)`、`background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`，以及 `tool call aborted`。

#### Token 影响

只有失败调用会增加这些保留 token；被中止的调用不会添加命令输出。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适或需要特别小心。它们是当前包约束，不是任务积压。

- **Windows 沙箱下的语言模式与命名管道捕获**——在 [Windows ACL 沙箱](../../sandbox/sandbox-windows-acl/README.zh.md)下，只读 pwsh 以 ConstrainedLanguage 启动，因为其临时目录写拒绝让 PowerShell 的 AppLocker 探测失败关闭：`Add-Type`、非核心 .NET 静态调用（`[System.IO.*]::`、`[math]::`）、COM 对象与反射会以 "only core types" 错误失败，且该模式无法从内部解除。workspace-write 的私有临时目录让探测完成，因此除非宿主策略另有规定，它保持 FullLanguage。两种受限模式都拒绝命名管道打开，因此受限命令内部的管道 stdio spawn 会以 EPERM 失败。工具描述把两条约定都教给模型；完整限制以后端 README 为准。
- **没有持久 shell**——每次调用都启动全新的 `pwsh -Command`；持久 shell 对应物是 [`@deepseek-ai/dsh-tool-pwsh-persistent`](../tool-pwsh-persistent/README.zh.md)，它跨调用保持一个按所有者隔离的 pwsh 存活。
- **PowerShell 方言约定**——模型必须编写 PowerShell（原生路径、`$env:` 变量），而不是 bash；没有方言翻译。
- **会话 cwd 身份未规范化**——workdir 基准就是会话头部 cwd 原样，不像 bash 工具那样以沙箱根规范化身份为准。在约束执行器下，策略的 workspace root 确实被规范化（由共享策略服务完成），因此当原始会话 cwd 与其规范形式不同时，workdir 与约束根可能分叉——这是推迟到共享 shell 工具基座抽取的对齐差距。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
