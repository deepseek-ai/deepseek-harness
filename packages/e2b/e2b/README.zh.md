---
description: "E2B 文件与命令工作的共享远程 Linux 沙箱：配置、生命周期，以及启动与关闭时会发生什么。"
kind: "package-reference"
---

# @deepseek-ai/dsh-e2b

[English](README.md) | 中文

## 概述

`dsh-e2b` 为 E2B 提供方家族提供一个共享的远程 Linux 沙箱：agent（智能体）的文件操作、shell 命令与终端都在这个沙箱内运行，而不是在你的机器上。家族启动时沙箱会自动创建，并在配置的生命周期到期或应用关闭时自动删除——其中保存的一切都会随之消失。你需要配置三件事：API 密钥、远程工作目录与沙箱生命周期。请与 `dsh-fs-e2b`、`dsh-subprocess-e2b` 一起使用；单独挂载它不会带来任何用户可见的功能。这里的一切都不会触及模型，而且任何已发布的组合都不会默认启用本家族。

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

当你希望 agent 的文件与命令工作在远程 Linux 沙箱而非你的机器上运行时，使用本包。它是 E2B 家族的基础：挂载文件系统与子进程包之后，所有这些工作都会共享同一个远程工作目录与进程环境。

### 何时选择

当工作应与宿主机器隔离时——例如你希望 agent 的文件编辑与命令运行发生在某个可丢弃的环境中——选择 E2B 家族。当在宿主上运行没有问题的时候，选择本地的文件系统与子进程包。本包对模型不可见，也不增加任何请求成本。

### 最小配置

三个设置很重要：API 密钥（或 `E2B_API_KEY` 环境变量）、绝对远程工作目录与沙箱生命周期。密钥错误、相对工作目录或无效生命周期都会在任何远程工作开始前拒绝启动。

```yaml
- name: '@deepseek-ai/dsh-e2b'
  config:
    apiKey: <E2B API key>
    cwd: /home/user/workspace
    timeoutMs: 300000

- name: '@deepseek-ai/dsh-subprocess-e2b'
- name: '@deepseek-ai/dsh-fs-e2b'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `E2B_API_KEY` | 宿主 SDK 连接的 API 密钥；绝不会安装进沙箱 |
| `cwd` | `/home/user/workspace` | 家族共享的远程工作目录；必须是绝对 POSIX 路径 |
| `timeoutMs` | `300,000` | 沙箱生命周期（毫秒）；到期后沙箱被删除 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-e2b)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 你能得到什么

挂载本包后，文件读写、shell 命令与终端都会在沙箱的工作目录内运行，因此 agent 看到的是一个一致的远程世界：它用文件功能写入的内容，正是它的命令能够读取的内容，反之亦然。远程工作目录若不存在，会自动创建。

### 沙箱的启动与停止

加载插件会在后台启动沙箱；文件系统与子进程功能在其就绪后即可使用。沙箱存活时间为配置的生命周期（默认五分钟），除非应用先停止——两种情况下沙箱都会被删除，因此请在此之前保存你仍需要的内容。如果运行期间沙箱消失（到期或被别处删除），家族会将其视为干净利落的结束，而不是错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释所有者背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **一个沙箱，一个句柄。** 所有适配器都等待同一个 `getSandbox()` promise，因此文件系统与进程操作共享同一个远程 Linux 世界。
- **构造即安全。** 沙箱以 `secure: true` 和 `lifecycle: { onTimeout: 'kill' }` 创建，因此超时必定删除它。
- **隔离的控制 shell。** `e2bControlEnvs()` 为每个内部命令 shell 提供全新随机生成的 `HOME`，`quoteE2BShellArg()` 则通过 SDK 不可避免的 `/bin/bash -l -c` 层保留不透明参数。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`E2BRuntime` 服务、`Config` schema、校验、沙箱创建与拆除 |
| — | 不发布运行时不变式伴生入口；沙箱创建与拆除只有一个 SDK promise，没有可交叉核对的独立事件或可变数据关系。 |

### 生命周期

`open()` 创建沙箱、准备 `cwd` 与私有运行时根目录、拒绝非目录或符号链接的运行时根目录，并执行 `chmod 700`。资源释放会阻止新的句柄获取、等待初始化完成并删除沙箱，把 `SandboxNotFoundError` 视为完全停稳。`getSandbox()` 在等待就绪后重新检查 disposed 标志，因此与就绪发生竞态的资源释放仍会拒绝获取句柄；急切连接失败会保持可观察，但不会拒绝插件加载，`getSandbox()` 会公开该失败。

### 初始化失败处理

任何目录初始化失败都会尝试删除一次并保留原始错误；回滚失败由 E2B 配置的沙箱超时约束（见开发备注）。提供方插件必须在该所有者之后加载、并在其之前 dispose（资源释放），因为每个适配器都等待同一个句柄。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从家族组合逐步进入子进程 seam 表面，以及远程执行世界背后的决策证据。

- [E2B 提供方家族地图](../README.zh.md)——三个包与可选组合。
- [子进程子系统](../../../docs/subsystems/subprocess.zh.md)——子进程 seam 约定与生成的 Cordis 表面，包括 `ctx.e2b`。
- [可移植执行世界决策](../../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.zh.md)——消费方为何委托给 `ctx.fs` 与 `ctx.subprocess`，以及留在宿主中的内容。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-e2b)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。本共享远程运行时所有者不注册任何模型上下文；提供方适配器与消费方拥有所有渲染效果。

#### KV Cache 影响

不会直接失效：所有者不贡献任何请求 token，也从不改变请求前缀，因此提供方缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 E2B 家族何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **不是完整的 harness 运行时**：Cordis 服务、agent（智能体）／会话状态、会话日志、LLM（大语言模型）请求、skill（技能）和 SDK 侧缓冲仍留在宿主进程中。
- **沙箱状态是短暂的**：资源释放与超时都会删除沙箱；重新连接、pause/leave 保留、模板、卷和快照均不在本 POC 范围内。
- **没有配置部署平台**：网络策略、宿主工作区同步与沙箱发现均不在本 POC 范围内。
- **`cwd` 是解析约定，而不是包含边界**：适配器与命令可以访问沙箱中的其他路径；E2B 网络访问也继续采用基础镜像的策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和包代码为准。

#### 开放：沙箱初始化回滚

`open()` 的失败路径只会尝试删除一次，并保留原始初始化失败。除非真实的双重失败超出 E2B 配置的沙箱超时，否则重试状态保持延后（TODO(e2b-setup-rollback)）。

</details>
