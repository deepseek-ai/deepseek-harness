---
description: "共享远程沙箱内的 shell 命令与终端：agent 可以在那里运行什么、输出如何处理，以及可以期待什么——面向 E2B 家族的部署方与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-e2b

[English](README.md) | 中文

## 概述

`dsh-subprocess-e2b` 让 agent（智能体）的 shell 命令与终端在远程沙箱内运行：agent 可以执行 Bash、打开交互式终端并读取其输出，体验与本地执行完全一致，而宿主机器上什么都不会运行。现有的命令、终端与语言服务器功能无需任何改动即可继续工作——不需要 E2B 专用工具。密钥与宿主环境变量绝不会泄漏进沙箱：只有 agent 显式请求的环境条目才会传入。请与 `dsh-e2b`、`dsh-fs-e2b` 一起使用，让命令、终端与文件共享同一个远程世界。主要代价是远程延迟——每条命令都要经过一段短暂异步初始化，而不是立即启动。

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

当 agent 的 shell 命令与终端应在远程沙箱内而非你的机器上运行时，使用本包。它是 E2B 家族的命令半边：命令、终端与文件共享同一个远程世界。

### 何时选择

当组合已经使用 E2B 沙箱且希望命令与终端在其中运行时，选择本包。宿主执行请选择本地子进程包。需要立即获得进程 ID 的工具——例如 ACP（Agent Client Protocol）子进程后端——无法使用本包。

### 配置

唯一设置是包检查运行中命令状态的频率；默认值适合大多数部署，调大它可以减少远程请求，代价是退出检测略慢。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pollMs` | `20` | 包检查运行中命令状态的频率（毫秒） |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subprocess-e2b)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 运行命令

agent 可以在沙箱中按指定的工作目录与环境运行命令，选择输出的交付方式（实时流式、在大小上限内捕获，或路由到应用自身的输出），并在命令卡住时停止它——停止会先礼貌地请求命令退出，短暂宽限期后再强制终止，因此卡住的命令不会残留。非常大的输出可以保存到沙箱中的文件里，供 agent 稍后读取。命令的退出码会正常报告；如果命令运行期间沙箱消失，该命令会被视为已结束而不是报错。

### 使用终端

agent 可以在沙箱中打开交互式终端、发送输入、读取输出，并向其中运行的程序发送信号——提示符、交互式工具与全屏程序的行为与本地完全一致。scrollback 与就绪检测等终端功能由终端工具提供，无需改动即可工作。

### 保持环境干净

命令在干净、沙箱原生的环境中运行：宿主变量与形似凭据的值不会被隐式传入，只有 agent 显式请求的条目才会被设置。这使密钥不会进入沙箱。

### 如果沙箱消失

沙箱是短暂的：如果命令或终端运行期间沙箱被删除——无论是到期、关闭还是被别处移除——受影响的命令会被视为干净地结束。请不要依赖能在沙箱中存续的工作。

默认沙箱镜像自带命令工作所需的运行时与工具：`node`、`bash`、`setsid`、`ps`、`awk`、`tr`、`env`、`base64`、`chmod`、`tee`、`head`、`rm`、`kill`、`id` 与 `getent`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **延后的远程身份。** 同步 seam 从不阻塞在网络请求上：句柄异步发布真实进程组 ID，包装层的私有文件是 pid、退出码与 spill 有效性的权威来源。
- **单一终止阶梯。** 终止、回滚与资源释放共享同一条进程组信号路径——先 `SIGTERM`，再 `SIGKILL` 加 SDK kill 回退——并把已证明的完全停稳视为最终状态。
- **环境必须显式。** 宿主内容与形似凭据的内容都不会隐式进入沙箱；每个环境值都会被清理，每个 `spec.env` 条目都是显式选择。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`E2BSubprocessRuntime`、`Config`、spawn 与 spawnTerminal、资源释放 |
| [`src/process.ts`](src/process.ts) | `E2BSubprocessHandle`：远程包装层、发布、终止、输出投影 |
| [`src/terminal.ts`](src/terminal.ts) | `E2BTerminalHandle`：PTY 分配、会话拆除 |
| [`src/environment.ts`](src/environment.ts) | 远程环境探测、清理、序列化 |
| [`src/output.ts`](src/output.ts) | base64 解码器与有界输出读取器 |
| [`src/remote.ts`](src/remote.ts) | 共享控制 shell 辅助：选项构造、轮询 tick、进程组信号 |
| — | 不发布运行时不变式伴生入口；存活远程句柄是私有的拆除所有权。 |

### 远程包装层

引导脚本会从沙箱 PATH 解析自身所需的工具，拒绝任何缺失或不可执行的路径，通过 `env -i` 与 `setsid --wait` 执行 exec，把进程组 ID 与退出码发布到 `ctx.e2b.runtimeRoot/processes` 下的私有文件，并把 stdout 与 stderr 重定向到带保留完成帧的 base64 编码器；`tee` 与 `head -c` 约束可选 spill 文件的大小。

### 进程身份与发布

同步 seam 会立即返回句柄，同时命令异步启动；`pid` 在包装层发布进程组 ID 且适配器验证通过之前保持 `-1`，stdin 与常规观察都等待该发布。启动信号会在分配前中止环境与私有状态准备；分配开始后，取消会等待可清理的临时 SDK 句柄。

### 环境边界

一次受信任的控制 shell 探测会从 passwd 条目解析沙箱用户的登录主目录，以 base64 ASCII 传输沙箱环境，再进行一次严格 UTF-8 解码；随后包装层移除环境中的 `DSH_*` 与形似凭据的名称（`*KEY*`、`*SECRET*`、`*TOKEN*`），并把每个有效的 `spec.env` 条目恢复为调用方显式选择。空名称、`=` 与违反 NUL 分帧规则的条目会在启动前被拒绝；在用户 profile 脚本运行前，此后的命令与 PTY 登录 shell 会获得位于根目录下、全新随机生成的 `HOME`，并为每个被清理的环境变量名设置空值覆盖。私有环境文件在使用后会被删除。

### 输出处理

远程包装层先把原始字节分流到可选的有界 spill 文件，再把每个实时分片编码为换行分隔的 base64 ASCII 帧；宿主会跨任意 SDK 回调边界增量恢复字节。pipe 模式把字节写入宿主 Node 流，inherit 模式写入 harness 进程流，collect 模式保留有界的宿主尾部并支持偏移读取。对于 collect 或 inherit 输出，超过 `graceMs` 后适配器会断开未完成的 SDK 流并扣留其不完整的 spill；原始 pipe 自然完成时则会等待无损传输并保留背压。批量与流式 stdin 都使用 SDK 句柄。

### 终止阶梯

终止与回滚共享同一条容错信号路径（`signalRemoteGroups`），在宽限期满时从 `SIGTERM` 升级到 `SIGKILL`，以 SDK kill 作为回退，并在报告成功前用有界进程表探测证明完全停稳；仅含僵尸进程的进程组视为空，`SandboxNotFoundError` 视为完全停稳。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从家族组合逐步进入子进程 seam 表面，以及渲染它的消费方。

- [E2B 提供方家族地图](../README.zh.md)——沙箱所有者与三包组合。
- [子进程子系统](../../../docs/subsystems/subprocess.zh.md)——子进程 seam 约定与生成的 Cordis 表面。
- [子进程 seam 包](../../subprocess/subprocess/README.zh.md)——本提供方实现的抽象约定。
- [Bash 执行器](../../shell/bash-local/README.zh.md)——向模型渲染所启动命令的消费方。
- [PTY 终端后端](../../terminal/terminal-bash/README.zh.md)——渲染终端会话的消费方。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subprocess-e2b)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

通过消费方 seam 间接影响模型，例如 bash 执行器家族；它们渲染远程输出、退出事实、后台增量与 spill 路径。

#### KV Cache 影响

不会直接失效：请求前缀变更由消费方 seam 负责；本后端的传输永远不会进入请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **SDK 仍会在宿主内存中保留完整命令输出**：即使本适配器公开的是有界原始字节尾部，E2B `CommandHandle.stdout` 与 `.stderr` 仍会累积 base64 传输内容，因此无法达到子进程 seam 通常提供的宿主内存边界，而且传输保留量大于源数据流。
- **不支持需要同步 PID 的消费方**：远程启动期间 `pid` 保持 `-1`；包括 ACP 子进程后端在内，要求立即获得正 PID 的消费方无法原样使用本提供方。
- **私有状态随沙箱生命周期存在**：进程目录与有效的 spill 文件会留在 `.dsh-e2b` 下，直到所有者删除沙箱；本 POC 不提供沙箱内清理。
- **控制状态与沙箱用户同 UID**：E2B 以同一默认用户运行每条命令，因此 `0700`/`0600` 权限无法把 `.dsh-e2b` 控制文件与并发运行的沙箱进程隔离开；真正的隔离需要 E2B 提供按命令用户或带外控制通道。
- **数值进程身份没有复用围栏**：E2B 公开基于数值 PID/PGID 的输入、信号发送与清理操作，却没有与身份原子绑定的替代方案；在 E2B 新增身份原语，或实际故障证明需要更窄的协议之前，替代方案继续延后。
- **初始环境探测会继承沙箱默认值**：E2B 会把命令覆盖与默认环境条目合并，因此探测无法在枚举未知且形似凭据的名称之前将它们置空；因此，该 POC 不支持把 secret 放入沙箱默认环境变量。
- **E2B 不公开信号事实**：适配器请求的 `SIGTERM` 或 `SIGKILL` 只有在包装层发布的直接退出码没有胜出时才报告为信号；其他未请求的 SDK 退出始终保留为退出码，包括等于 `128 + signal` 的值。
- **无法精确检查终端 stdin 等待状态**：E2B 会公开前台进程组，但不提供证明其正在等待 fd 0 所需的 syscall 证据，因此通用 PTY 后端会回退到受控提示符标记与有界静默机制。
- **依赖 Linux 工具与 E2B 传输语义**：没有 Windows、逃逸会话恢复或网络分区的保真层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和包代码为准。

#### 开放：数值进程身份

E2B 公开基于数值 PID/PGID 的输入、信号发送与清理操作，却没有与身份原子绑定的替代方案。适配器会尽量减少宿主往返，并在 E2B 新增身份原语或实际故障证明需要更窄的协议之前，继续延后替代方案（TODO(e2b-pgid-identity)）。

#### 开放：替换环境与状态观察

由于 E2B 会合并命令覆盖，初始环境探测会继承沙箱默认值；又因为 E2B 无法独立于后代持有的输出观察直接命令的退出，collect/inherit 命令状态需要控制面轮询。两者都只能靠 E2B 的新原语来弥合（TODO(e2b-replace-environment)、TODO(e2b-status-watch)）。

</details>
