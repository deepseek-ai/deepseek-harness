---
description: "通过 OAR 添加实验性单次编程智能体委派，并允许每次调用选择运行时。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-subagent-oar

[English](README.md) | 中文

## 概述

将此实验性提供方与 `subagent_oar` 工具组合，即可在选定的工作区中向 Codex 和 Claude Code 委派独立文本任务。提供方内嵌 OAR 库，因此无需单独安装 OAR CLI。Codex 和 Claude Code 使用已安装的原生 CLI、认证和设置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完善事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 组合 Profile

委派前，请先安装并认证原生 Codex 和 Claude Code CLI。DSH Host 必须能访问它们的可执行文件。提供方在接受委派之前不会启动原生会话。

在组合中将此提供方和 `@deepseek-ai/dsh-experimental-tool-subagent-oar` 声明为依赖，然后通过 Profile 补丁添加这些行：

```yaml
- insert:
    - id: experimental-subagent-oar-codex
      name: '@deepseek-ai/dsh-experimental-subagent-oar'
      config:
        runtime: codex
        providerName: oar-codex
        launchArgs:
          - -c
          - sandbox_mode="workspace-write"
    - id: experimental-subagent-oar-claude
      name: '@deepseek-ai/dsh-experimental-subagent-oar'
      config:
        runtime: claude
        providerName: oar-claude
        launchArgs:
          - --permission-mode
          - dontAsk
          - --permission-prompts
          - none
    - id: tool-subagent-oar
      name: '@deepseek-ai/dsh-experimental-tool-subagent-oar'
      config:
        providers:
          codex: oar-codex
          claude: oar-claude
```

通过 `dsh` Profile 启动完成后的组合。此示例为每个提供方分配不同名称，并在模型可以委派任务之前固定原生权限参数。

### 提供的能力

独立的 [`subagent_oar` 工具](../tool-subagent-oar/README.zh.md)为每次调用选择已配置的运行时。其包文档定义参数和父智能体可见的通知。

| `runtime` | 提供方 | 示例中的原生权限 |
|---|---|---|
| `codex` | `oar-codex` | Codex `workspace-write` 沙箱；不弹出审批提示 |
| `claude` | `oar-claude` | Claude Code `dontAsk`；禁用权限提示 |

每次委派都会启动一个原生会话，执行一个文本任务。父 Session 保留外部任务标识和最终结果；此提供方不创建 DSH 子 Session，也不提供后续输入或恢复操作。

### 配置运行时实例

每个提供方实例选择一个 OAR 运行时，并注册唯一的 `providerName`。要暴露另一个运行时，请添加提供方行并扩展[外部工具的提供方映射](../tool-subagent-oar/README.zh.md#use-this-package)。后续 Profile 层可以覆盖这些配置。未知 OAR 运行时 id 会在其提供方加载时失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `runtime` | 必填 | OAR 默认注册表中的运行时 id |
| `providerName` | `oar` | 向 DSH 子智能体服务注册的名称 |
| `model` | 原生设置 | 可选的原生模型选择 |
| `effort` | 原生设置 | 可选的原生推理强度，由运行时决定是否支持 |
| `launchArgs` | `[]` | 原生运行时参数，包括权限设置 |
| `env` | `{}` | 清理环境中的凭据和 DSH 变量后应用的显式环境覆盖；`null` 移除变量 |
| `timeoutMs` | 无 | 可选的启动后轮次时限；省略时仅由父会话取消 |

对于 Claude，请在 `launchArgs` 中显式选择原生权限模式，并保留 `--permission-prompts none` 以便无人值守运行。Claude 实例如果不提供权限模式参数，会继承 OAR 默认的权限绕过。替换示例的参数数组也会替换其中显式设置的权限。

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-subagent-oar)定义接受的字段和校验规则。如果子进程需要环境变量中的 API 凭据，必须通过 `env` 提供；原生账户文件仍可通过原生运行时设置访问。

固定版本的 OAR 默认注册表包含 `antigravity`、`claude`、`codex`、`grok`、`kimi`、`opencode` 和 `pi`。提供方配置接受每个已注册的运行时 id。Codex 和 Claude 有原生 e2e 覆盖。其他运行时需要显式添加提供方和工具映射，且仍未经验证。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

此示例挂载同一提供方的两个实例和[外部委派工具](../tool-subagent-oar/README.zh.md)。[`src/index.ts`](src/index.ts)注册提供方；工具包负责运行时选择和任务展示。提供方使用 OAR 的运行时注册表和会话 API 完成启动、单次提示、答复收集、取消及释放。OAR 负责原生进程；这些会话不使用 DSH 子进程提供方。

依赖补丁对原生安装探测应用环境覆盖，并允许 Claude 显式使用 `--permission-mode`，并在存在该参数时关闭 OAR 强制的权限绕过。示例传入 `--permission-mode dontAsk --permission-prompts none`。Codex 接收 `-c sandbox_mode="workspace-write"`。OAR 将 Codex 审批策略设为 `never`。两条路径均不将原生审批请求转发到 DSH 交互界面。Codex 启动失败时会停止 app-server 并等待其退出，包括响应中缺少线程 id 的情况。

只有根智能体文本参与答复。当 OAR 提供消息 id 时，选择最后一条非空消息；否则拼接根文本。原生推理、工具事件和转录历史不会进入父 Session。原生历史遵循所选运行时自身的持久化行为。提供方错误保留原生原因供本地调试；默认日志仅输出安全的阶段和类别摘要，因为原生原因可能包含凭据。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [实验性包](../README.zh.md) — 实验性状态与可选交付。
- [子智能体服务](../../subagent/subagent/README.zh.md) — 提供方生命周期和最终结果。
- [OAR 子智能体工具](../tool-subagent-oar/README.zh.md) — 运行时选择和父智能体可见行为。
- [子智能体子系统](../../../docs/subsystems/subagent.zh.md) — 父智能体调度和完成通知。
- [架构](../../../docs/architecture.zh.md) — Profile 层组合。

-----

<a id="model-experience"></a>
## 模型体验

### 子请求

#### 模型看到什么

所选原生运行时接收 `prompt` 中的文本，`cwd` 设为解析后的子任务目录。其自身的模型、工具、配置和历史决定子请求；实例配置提供模型、推理强度、参数和环境覆盖。

#### Token 影响

原生运行时承担独立上下文和轮次的 token。子智能体推理和工具流量不会添加到父上下文。

#### KV Cache 影响

子请求独立于父请求的缓存前缀。原生运行时行为决定子请求的缓存复用。

### 父智能体结果（间接）

#### 模型看到什么

通过[OAR 子智能体工具](../tool-subagent-oar/README.zh.md#model-experience)，父智能体收到此提供方选中的根答复或失败通知。消费者负责工具 schema 和确认消息。

#### Token 影响

最终通知将选中的答复或失败详情加入父上下文。

#### KV Cache 影响

提供方结果通过共享子智能体服务追加。[消费者](../tool-subagent-oar/README.zh.md#model-experience)负责会影响父请求缓存前缀的工具 schema 变更。

## 已知限制与待完善事项

<a id="known-limitations-and-deferred-work"></a>

- **实验性运行时覆盖：** 只有 Codex 和 Claude Code 有原生 e2e 覆盖。其他已注册运行时可以选择，但尚未由 DSH 验证。
- **原生配置：** 此提供方不安装、认证或升级原生智能体。缺少可执行文件和原生配置错误会在委派启动时呈现。
- **无人值守权限：** 原生权限模式生效，但没有 DSH 审批界面。Claude 需要支持 `--permission-prompts none` 的 CLI 版本；此提供方不提供工具限制功能。OAR 会记录意外的 Codex 审批或用户输入请求，但不会回答。如果运行时等待输入，请取消任务或配置 `timeoutMs`。
- **启动取消：** OAR 不提供会话打开期间的即时取消。取消操作会等待打开完成并释放迟到的会话；显式配置的 `timeoutMs` 仅在成功打开后开始计时。
- **进程与历史所有权：** OAR 处理原生进程，原生运行时可能保留转录记录。DSH 不对这些进程应用其子进程沙箱或受管理的后代进程清理。
- **单次文本：** 不提供继续、恢复、结构化输出、进度流或副作用回滚。取消前的原生更改会保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
