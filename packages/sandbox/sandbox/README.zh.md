---
description: "进程沙箱服务约定：面向组合、使用或扩展同世界子进程隔离的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox

[English](README.md) | 中文

## 概述

`dsh-sandbox` 将同世界子进程限制在文件效果策略之下：命令以 `read-only` 运行、只能写入会话工作区（`workspace-write`）或不受限制地运行（`danger-full-access`），每次受限执行都遵循一份逐调用策略。bash 与 pwsh 执行器直接消费它，因此命令及其派生的所有进程都在限制下运行，消费方无需知道背后是哪个平台 runner。无法强制执行所请求的模式时，调用以 `SANDBOX_UNAVAILABLE` 错误快速失败，绝不会不受限制地运行。被拒绝的调用可以请求一个由人类批准一次、严格更宽的模式。隔离仅限同世界——后端与宿主共享内核和文件系统，容器、microVM 与远程执行器会替换整个能力。

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

将此服务与一个后端和一个受限消费方组合，消费方运行的每条命令都会在你解析的策略下执行——你只看到隔离结果及其强制执行完整度，永远看不到 runner。

### 何时选择

当组合需要在宿主机上隔离子进程时选择本包：本地后端与受限执行器都实现这个约定，因此在 `ctx.sandbox` 后挂载 `sandbox-local`、在 `ctx.shell` 后挂载受限执行器，就能让每次 bash 或 pwsh 调用都有受限默认值。当进程必须在隔离环境中运行时请另选方案——容器、microVM 或远程执行器会替换整个 `ctx.shell`/`ctx.fs` 能力，而不是在这里添加后端。

### 隔离命令

挂载服务、后端与受限执行器；[base bundle](../../bundle/base/cordis.patch.yml)拥有随附组合。

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'     # the per-platform backend provider (ctx.sandbox)
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'    # the deployment default mode and workspace-write root
  config:
    mode: workspace-write                    # the deployment default every session starts from
    workspaceRoot: !!js process.cwd()        # the boundary workspace-write may write under
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'      # the confined executor behind ctx.shell
```

使用该组合时，bash 调用在 `workspace-write` 下受限运行：工作区内写入成功，工作区外写入被拒绝，模型可以通过下面的升权流程恢复。

### 模式与强制执行

模式指明命令可以执行的文件操作；强制执行完整度报告后端对这些操作的管辖程度。

| 模式 | 效果 |
|---|---|
| `read-only` | 拒绝写入，必需 sink（如 `/dev/null`）除外 |
| `workspace-write` | 允许写入工作区根目录及后端定义的临时区域 |
| `danger-full-access` | 绕过隔离；消费方直接 spawn 原始 argv |

强制执行逐调用报告：`full` 表示后端管辖模式承诺的每个文件操作，`partial` 表示活动后端或较旧的内核 ABI 只管辖子集——Windows ACL 档与较旧的 Landlock ABI 是当前的部分强制执行情形，需要绝对边界的消费方可以拒绝或向上暴露它们。

### 被拒绝的调用与升权

受限调用被拒绝时，操作会报告指明模式的拒绝标记——`[sandbox: file access denied under <mode> mode]`——组合声明升权能力时还会给出升权提示。模型可以用 `sandbox_permissions`（足以放行的最窄更宽模式）加 `justification` 重试一次完全相同的调用；用户会看到一次审批提示，可以选择允许一次、拒绝或取消。升权必须严格宽于调用的生效模式，且只作用于该次调用。

### 故障关闭行为

没有后端能强制执行所请求的模式时，调用以 `SANDBOX_UNAVAILABLE` 失败，而不是不受限制地运行；错误文本会指明缺失的平台 runner。启动后失败的后端还会报告结构化的 runner 失败签名，因此损坏的沙箱可以与命令失败区分开。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释约定背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **按约定限同世界。** `ctx.sandbox` 在宿主路径文件策略下包装 argv；容器、microVM 与远程执行会替换周边能力 seam。
- **策略随调用传递。** `SandboxPolicy` 逐调用携带，绝不在提供方上固定：两个消费方可以同时按不同策略隔离，获批的升权重试只是用更宽策略发起的新调用。默认与解析是消费方显式步骤。
- **故障关闭。** `confine()` 返回受强制的 argv，或抛出 `SandboxUnavailableError`；绝不允许静默无限制放行，功能探测用于仲裁多 runner 链。
- **统一的拒绝与升权词汇。** 标记与提示文本以及严格更宽阶梯都放在这里，使 bash 与 fs 家族不会漂移。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SandboxProvider` 服务、模式/强制执行/策略类型、故障关闭错误 |
| [`src/escalation.ts`](src/escalation.ts) | 升权词汇：更宽模式阶梯、参数校验、拒绝与提示标记、审批编排 |
| [`src/roots.ts`](src/roots.ts) | 可写根目录推导，Seatbelt profile 与进程内 fs 栅栏共享 |
| — | 不发布运行时不变式伴生入口；抽象 seam 不注册事件或数据关系。 |

### 升权编排

阶梯是封闭表——`read-only` 可升权到 `workspace-write` 或 `danger-full-access`，`workspace-write` 只能升权到 `danger-full-access`——在执行时检查，绝不写入工具 schema，schema 的枚举保持封闭的目标词汇。[`approveEscalation`](src/escalation.ts) 校验 `sandbox_permissions`/`justification` 配对、不提示人类就拒绝非加宽请求，并在任何执行前把每个审批结果映射到各自的错误。

### 可写根目录

`workspace-write` 意味着「工作区根目录加宿主临时区域」：`writableRoots` 以规范化方式推导该白名单，解析符号链接并去重，使 Seatbelt profile 与进程内 fs 栅栏授予完全相同的根目录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

先从子系统参考文档了解穷尽式约定，再看实现它的后端、消费方与策略来源。

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——完整词汇、逐调用策略与分类方言。
- [子进程沙箱决策](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)——能力边界、升权设计与延期阶段。
- [本地沙箱后端](../sandbox-local/README.zh.md)——`ctx.sandbox` 背后的各平台 runner。
- [Bash 沙箱执行器](../../shell/bash-sandbox/README.zh.md)——受限的 bash 消费方。
- [沙箱策略包](../sandbox-policy/README.zh.md)——逐调用模式与工作区根目录的来源。

-----

<a id="model-experience"></a>
## 模型体验

### 间接的限制错误

#### 模型看到什么

通过 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.zh.md) 和 [`dsh-tool-bash`](../../shell/tool-bash/README.zh.md)，请求的受限模式没有可用后端时会产生错误码 `SANDBOX_UNAVAILABLE` 及下方精确错误；执行期 runner 失败会追加 ` Runner failure: <detail>`。

##### 精确错误

```markdown
sandbox mode "<mode>" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.
```

#### Token 影响

条件性错误文本对该次调用可见，并保留在历史中直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 升权请求与结果

#### 模型看到什么

被拒绝的调用会呈现标记 `[sandbox: file access denied under <mode> mode]`，组合声明升权能力时还会呈现提示 `[sandbox: escalation available — retry this exact <subject> once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`。重试携带 `sandbox_permissions` 与 `justification`；用户的 `allowed-once`／`rejected`／`cancelled` 决定成为该调用的结果文本。

#### Token 影响

只有被拒绝调用的错误与任何升权结果文本可见；两者都会保留在历史中直到压缩。

#### KV Cache 影响

仅追加；升权文本位于保留前缀之后，不会使已缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 何时不合适，或何时需要特别运维。它们是当前包约束，不是通用沙箱对比或任务积压。

- **文件操作是完整的策略词汇**——该 seam 不表达网络、进程、系统调用、设备或凭据限制。
- **仅限同世界隔离**——容器、microVM 与远程执行需要替换能力实现，而不是在此添加提供方。
- **拒绝报告是一种 stderr 方言**——该 seam 返回后端签名，而非类型化运行时拒绝通道，需要分类的消费方必须从子进程输出推断。
- **Runner 诊断使用带内通道**——退出状态与 stderr 证据无法证明匹配行由哪个进程写入，因此故意模仿 runner 的受限子进程可能造成错误的可用性或诊断归因；这无法绕过隔离，带外 runner 状态通道暂缓实现。
- **每个上下文只有一个提供方**——同时组合不同沙箱机制需要提供方级阶梯或独立 Cordis 上下文；调用方逐调用选择策略，而非后端标识。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决方向与开放问题。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：消费方与环境

[沙箱决策](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)列出延期阶段——可选的 `subagent-acp` 消费方（隔离子 agent（智能体），默认不隔离）与环境一致的能力组示例。两者均未决定；该笔记列为延期的 Windows 链已通过 `sandbox-local` 的 ACL 受限令牌档交付。

</details>
