---
description: "面向部署方与维护者的沙箱 Bash 执行器说明，用于选择、配置或排查受限命令执行及其拒绝与升权事实。"
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-sandbox

[English](README.md) | 中文

## 概述

`dsh-bash-sandbox` 是沙箱消费型 Bash 执行器：每条命令都以全新的 `bash -c` 进程运行，经 `ctx.sandbox` 能力隔离，而不是以 harness 进程的完整文件权限运行。每个已结算的结果都携带命令运行时的模式、沙箱是否拒绝了文件操作，以及所选 runner 对请求模式的强制执行完整度。当没有 runner 能强制执行受限模式时，调用按失败关闭原则抛结构化 `SANDBOX_UNAVAILABLE` 错误，绝不无隔离地运行。它是 `dsh-bash-local` 的受限兄弟包——共享其进程机制——工具层的升权字段也只在挂载它时才出现。

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

当命令不得以 harness 进程的完整文件权限运行时，用本执行器替代 `dsh-bash-local`。它注册为 `ctx.shell`，并要求一个 `ctx.sandbox` 提供方加上 `ctx.sandboxPolicy`；面向模型的 `bash` 工具基于它不加改动地工作，并公布 `sandbox_permissions`/`justification` 升权字段。

### 何时选择

当部署需要为 Bash 命令提供文件级隔离时选择它：已配置的策略决定默认模式与工作区根目录，每个会话还可以通过工具的升权流程按调用使用不同模式。模式只约束文件影响——网络仍不受限制，进程可见性因后端而异。需要非隔离执行，或平台没有可用沙箱后端时，请改为挂载 `dsh-bash-local`。

### 模式与文件影响

| 模式 | 文件影响 |
|---|---|
| `read-only`（默认） | 任何位置都不可写；在 `/dev` 中只有 `/dev/null` 节点可写，因此 `>/dev/null` 仍可正常工作 |
| `workspace-write` | 只能写入策略的工作区根目录加 `/tmp`（bwrap 下为临时目录，Landlock 下为宿主 `/tmp`，Seatbelt 下为 `/private/tmp` 加每用户临时目录） |
| `danger-full-access` | 不作限制；绝不咨询提供方，结果携带 `sandbox: { mode, denied: false }` |

### 最小配置

本执行器自身不携带任何沙箱配置：默认模式与工作区根目录来自 `ctx.sandboxPolicy`，runner 选择属于 `ctx.sandbox` 提供方。它自己的配置就是本地执行器的旋钮，逐字继承；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-bash-sandbox)是穷尽式真源。

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd() # fallback for calls without a session cwd
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
```

### 拒绝是结果事实

被拒绝的命令会被报告，而不是静默重试：结果携带 `sandbox: { mode, denied: true }`，面向模型的工具会追加拒绝标记。当升权可用时，模型可以用最窄的充分宽模式与一句理由重试同一条命令一次；批准提示会询问用户，未经批准绝不执行任何东西。本执行器自身绝不协商权限——覆盖值由工具层驱动。

### 失败与恢复

如果没有 runner 能强制执行受限模式，前台调用以 `SANDBOX_UNAVAILABLE` 失败，后台进程则记录 runner 失败事实——绝不会静默无隔离运行。可归因于 runner 的 spawn 失败以原始 spawn 错误作为详情；其他 spawn 拒绝保持本地执行器普通的命令启动语义。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释执行器的设计并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计概念

本执行器是 `ctx.shell` seam 的沙箱 Service Provider：它继承 `dsh-bash-local` 的进程机制，把每条命令的精确 `['bash', '-c', command]` argv 经 `ctx.sandbox.confine()` 重新包装，并直接 spawn 返回的 argv。由哪种平台 runner 限制命令、以及是否有 runner 可用，属于提供方职责；本包只负责 bash 侧：所选模式、强制执行完整度，以及结果上的拒绝分类。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SandboxBashExecutor`、按进程保留事实、run/start 包装 |
| [`src/helpers.ts`](src/helpers.ts) | 拒绝、runner 失败与 runner spawn 失败分类 |
| — | 不发布运行时不变式伴生入口；分类在结果中可观察。 |
| `tests/` | 跨 bwrap、Landlock 与 Seatbelt runner 演练的行为 |

### 主要流程

对受限模式，`resolve()` 标记每次调用的策略（会话的模式覆盖值，或部署回退）；`run` 与 `start` 把 bash argv 经提供方包装，再把受限 argv 交给继承的 subprocess 路径。结算时执行器对结果分类：runner 失败优先于拒绝（命令从未运行），stderr 携带后端拒绝方言的失败运行报告 `denied: true`，每次受限运行都携带模式与强制执行事实。`danger-full-access` 完全绕过提供方，并标记 `denied: false`。

### 不变式

- **失败关闭**——受限模式没有可用 runner 时抛 `SANDBOX_UNAVAILABLE`；受限策略绝不会出现无隔离直通。
- **seam 只报告拒绝**——本执行器从不授予权限；批准流程位于工具层。
- **按进程保留事实**——隔离事实在结算前按句柄保留，因为提供方可能在重叠调用之间改变强制执行方式。
- **只约束文件影响**——模式词汇只声称文件影响。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当执行器约定不够用时阅读以下页面。它们从 seam 进入本执行器所消费的沙箱能力。

- [shell seam](../shell/README.zh.md) —— 本提供方实现的执行器约定，包括请求/spec 拆分。
- [bash-local](../bash-local/README.zh.md) —— 本执行器继承的进程机制。
- [sandbox seam](../../sandbox/sandbox/README.zh.md) —— 隔离能力、其模式与失败关闭约定。
- [sandbox-policy](../../sandbox/sandbox-policy/README.zh.md) —— 本执行器遵守的每会话模式与工作区根目录。
- [sandbox-local](../../sandbox/sandbox-local/README.zh.md) —— 随附的 runner 后端：bwrap、Landlock 与 Seatbelt。
- [tool-bash](../tool-bash/README.zh.md) —— 面向模型的 `bash` 工具及其升权面。
- [沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md) —— 沙箱设计、升权与切换约定。

-----

<a id="model-experience"></a>
## 模型体验

### 间接的 Bash 工具 schema

#### 模型看到的内容

基线是生成的 [`dsh-tool-bash` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-bash)。通过公布表明启用隔离的 `sandboxMode` 能力，此后端会为 `bash` 增加 `sandbox_permissions`（enum 为 `workspace-write` | `danger-full-access`）与 `justification`。策略归属方会另行贡献当前且不区分具体能力的 `sandbox:policy` 上下文。

#### Token 影响

在 `bash` 可见的请求上，schema 固定增加少量内容，另有一条由 `dsh-sandbox-policy` 负责的当前策略子句。

#### KV Cache 影响

常驻策略变化会在保留的历史之后追加一份由归属方渲染的完整上下文快照，并使既有 system/history 前缀保持逐字节不变。更改执行器能力会改变 `bash` schema。

### 间接的 Bash 工具结果

#### 模型看到的内容

在普通有界输出之后，被拒绝的调用会精确追加 `[sandbox: file access denied under <mode> mode]`。当升权可用时，接下来精确追加 `[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`。已结算的后台 runner 失败则追加 `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; this is a sandbox problem, not a command failure]`。

#### Token 影响

除普通输出外，正常允许的运行不会增加 token。拒绝或失败会增加上述有条件标记，并保留到上下文压缩。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 间接的 Bash 工具错误

#### 模型看到的内容

如果没有 runner 能强制执行受限模式，前台调用会传播来自 sandbox seam 的 `SANDBOX_UNAVAILABLE` 错误。可归因于 runner 的 spawn 失败以原始 spawn 错误作为详情；没有 `ENOENT`/`EACCES` 的 `path` 或 `syscall` 证据指明 `argv[0]` 的拒绝仍是普通的命令启动错误。已结算的 runner 失败以匹配到的致命 stderr 行作为详情，并保留原始 stderr 收集结果；追加的 `Runner failure: <detail>` 是权威诊断，优先于通用的 `SANDBOX_UNAVAILABLE` 前缀。

#### Token 影响

该次调用会在相应条件下显示错误文本，该文本会保留在历史记录中直到上下文压缩。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本执行器何时不是通用安全边界。它们是当前包约束，不是路线图。

- **限制只覆盖文件影响**——不提供网络限制和统一的进程可见性保证，因此这些模式不是通用安全沙箱。
- **拒绝从失败命令的 stderr 推断**——后端特征使该推断可跨平台使用，但包含相同特征的应用错误可能被分类为拒绝，也可能遗漏未出现在保留尾部中的拒绝。
- **异步观测到的后台 runner 失败没有即时错误通道**——它记录在已结算进程上，并在调用方用 `job_output` 读取通用任务时呈现；同步抛出且指明 runner 路径的 subprocess 错误则会让 `start()` 立即失败。
- **`danger-full-access` 有意绕过 `ctx.sandbox`**——它是显式无约束模式，不是更宽的沙箱 profile。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
