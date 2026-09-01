---
description: "面向 Linux、macOS 或 Windows 上选择、配置或排查进程隔离的用户与维护者的本地各平台沙箱后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-local

[English](README.md) | 中文

## 概述

`dsh-sandbox-local` 提供 `ctx.sandbox` 背后的平台隔离后端：Linux 在 `bwrap` 可用时用其运行命令，否则使用 Landlock launcher；macOS 使用 Seatbelt（`sandbox-exec`）；Windows 使用 ACL 受限令牌 runner。它每台主机选择一个 runner，因此每条命令及其派生的所有进程都在限制下运行。没有可用 runner 时，提供方以 `SANDBOX_UNAVAILABLE` 快速失败——命令绝不会静默无限制运行。每次包装都会报告后端对模式的强制执行完整度（`full` 或 `partial`）及后端的拒绝签名，因此消费方可以区分损坏的沙箱与被拒绝的命令。在 `ctx.sandbox` 后挂载它并配一个受限执行器，即可让每次 bash 或 pwsh 调用都有受限默认值。

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

在 `ctx.sandbox` 后挂载此提供方并配一个受限执行器，执行器 spawn 的每条命令都会在你解析的策略下受限运行。随附的 [base bundle](../../bundle/base/cordis.patch.yml)拥有默认策略与执行器接线。

### 何时选择

当命令必须在宿主机上受限运行时选择它：它是挂载 `ctx.sandbox` 的 Linux、macOS 与 Windows 组合的默认后端。当进程必须在隔离环境中运行时请另选机制——容器或远程执行器会替换整个能力，而此提供方与宿主共享内核和文件系统。

### 最小配置

加载沙箱服务并挂载提供方；以下默认值即选择策略。

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `runnerCommand` | `[]` | 自定义 runner argv；会追加 bwrap 兼容的 profile 参数，断言完全强制执行，并跳过内置选择与探测 |
| `runnerFailureSignatures` | `[]` | 识别自定义 runner 自身失败方言的不区分大小写 stderr 子串；与 `runnerCommand` 搭配必需 |
| `probeTimeoutMs` | `5,000` | 每次竞争 runner 候选功能探测的超时时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sandbox-local)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 受限执行与强制执行

挂载提供方后，命令在你逐调用解析的模式下运行。强制执行是报告的事实，而非承诺：`full` 表示后端管辖模式承诺的每个文件操作，`partial` 表示它只管辖子集——Windows ACL 档（Everyone 与硬链接边界）与较旧的 Landlock ABI 是当前的部分强制执行情形，因此需要绝对边界的消费方可以拒绝或向上暴露它们。被拒绝的文件操作通过后端的拒绝方言呈现，执行命令前失败的 runner 会报告结构化的 runner 失败签名。

### 失败与恢复

不受支持的平台或不可用的 runner 会快速失败：`confine()` 抛出 `SANDBOX_UNAVAILABLE` 并列出该平台的 runner 选项，消费方会呈现该错误，而不是让命令不受限制地运行。启动后拒绝自身 profile 的 runner 由其致命 stderr 签名与退出码识别，因此损坏的沙箱不会被误认为被拒绝的命令。`runnerCommand` 覆盖是操作方断言：它跳过功能探测，并假定配置的 runner 诚实实现与 bwrap 兼容的 profile。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 runner 选择、各平台 profile 与失败方言；可观察行为已在[使用本包](#use-this-package)中完整说明。

### runner 选择

选择按平台优先、探测其次：每个平台都有 runner 链（`linux`：`bwrap` 再 Landlock；`darwin`：Seatbelt；`win32`：ACL 受限令牌 runner）。唯一候选直接选择、不探测；竞争候选按链序各执行一次功能探测，首个可用结论在提供方生命周期内缓存。没有链的平台、或链上所有探测都失败时，平台不可用，并在 `confine()` 处快速失败。

### 平台 profile

bwrap profile 组合只读宿主根目录、全新 `/dev` 与私有 PID 命名空间中的 `/proc`——命令可管理其后代，但看不到宿主进程，因此 procfs 魔法链接无法绕过挂载；`workspace-write` 另加临时的 `/tmp` 与可写工作区绑定挂载。[私有 PID 笔记](../../../.agents/notes/implemented/bug-fix/2026-08-06-bwrap-private-pid-namespace.zh.md)记录该边界。

Landlock launcher 以 npm 分发的原生插件（`@deepseek-ai/node-addon-landlock-run`）提供平台 launcher、功能探测与授权词汇；此提供方只做模式到授权的映射，把路径解析与探测解析保留在带版本的 binary 中。

Seatbelt profile 默认允许，带 `(deny file-write*)` 与来自共享 `writableRoots` 辅助函数的写入 allow-list，因此恰好管辖模式承诺的文件操作；每个根目录都经过规范化，因为 Seatbelt 匹配解析后的路径（`/tmp` 就是 `/private/tmp`）。

Windows 档为每个工作区保留一个确定性写入 SID 和常驻 ACE，同时为每个活跃的会话/工作区对分配一个随机私有临时目录，以及不同的 SID 和可撤销 ACE——共享工作区的会话共享其预期写权限，却不会继承彼此的临时目录权限。新的提供方总会选择新的临时路径和 SID，因此崩溃残留既无法阻止恢复的会话，也无法向其授权。该档报告 `partial` 强制执行，因为受限令牌必须保留 Everyone，且 NTFS 硬链接会把同一文件对象别名为多个路径。

### 拒绝与 runner 失败方言

每个 runner 的内核都有自己的拒绝方言，随每次包装以 `denialSignatures` 携带，`runnerFailureRules` 则给出每个 runner 的致命签名，因此消费方先分类 runner 拒绝，再检查拒绝签名。精确的字符串与退出码位于 [`src/index.ts`](src/index.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：runner 链选择、功能探测、逐调用包装、ACL 授权生命周期 |
| [`src/profiles.ts`](src/profiles.ts) | 各平台 profile 构建器：bwrap 挂载、Landlock 授权、Seatbelt SBPL |
| — | 不发布运行时不变式伴生入口；故障关闭约定在包装边界强制执行。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

先从子系统参考文档了解共享词汇，再看 seam 约定、消费方与 win32 档。

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——模式、逐调用策略与分类方言。
- [沙箱 seam 包](../sandbox/README.zh.md)——本提供方实现的服务约定。
- [Bash 沙箱执行器](../../shell/bash-sandbox/README.zh.md)——受限的 bash 消费方。
- [Windows ACL 受限令牌档](../sandbox-windows-acl/README.zh.md)——本提供方挂载的 win32 后端。
- [子进程沙箱决策](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)——能力边界与 runner 选择语义。

-----

<a id="model-experience"></a>
## 模型体验

通过 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.zh.md) 和 [`dsh-tool-bash`](../../shell/tool-bash/README.zh.md) 间接影响；它们渲染此提供方的强制执行与拒绝事实，而 [`dsh-sandbox`](../sandbox/README.zh.md) seam 拥有 `SANDBOX_UNAVAILABLE` 文本、本提供方拥有 runner 选择，profile 不进入上下文。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方何时不合适，或何时需要特别运维。它们是当前包约束，不是通用平台对比或任务积压。

- **Windows ACL 只能实现部分强制执行**——受限令牌必须保留 Everyone 以完成进程初始化，因此授予 Everyone 写访问的外部对象仍可写；NTFS 硬链接也会使工作区路径与外部路径指向同一个文件对象。提供方报告 `enforcement: 'partial'`，而不会把该边界夸大为完整强制执行。
- **Landlock 可能只实现部分强制执行**——较旧且受支持的内核 ABI 只能限制自身公开的访问类别，因此报告 `enforcement: 'partial'`，不会夸大为完整强制执行。
- **Seatbelt 依赖已弃用的 `sandbox-exec`**——macOS 仍会提供它，但若 Apple 移除该私有策略引擎，该提供方无法替换或探测。
- **runner 选择在提供方生命周期内缓存**——安装、移除或修复 runner 后，必须重载插件才能改变选择。
- **`runnerCommand` 是操作方断言**——配置的自定义 runner 会跳过功能探测，并假定它诚实实现与 bwrap 兼容的 profile；如果它本身是 Bash 脚本，其解释器启动发生在该脚本施加约束之前。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决方向与开放问题。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：环境一致的能力组

[沙箱决策](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)把环境一致的能力组示例（例如 bash 加 fs 针对同一个容器）列为延期阶段；该方向尚未决定。

</details>
