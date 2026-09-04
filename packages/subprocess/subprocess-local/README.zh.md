---
description: "面向部署方与维护者的子进程服务本地宿主提供方说明：在宿主机器上运行受管进程树与真实终端会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-local

[English](README.md) | 中文

## 概述

在需要于宿主机上运行子进程的组合中挂载 `dsh-subprocess-local`：它解析本地可执行文件、以显式 stdio 运行 detached 进程树，并通过 `node-pty` 提供真实终端会话。它没有任何配置，因此每项处置方式、限制、终端尺寸与宽限期都随 spawn 请求来自调用方能力 seam。输出收集在内存中保留一段有界尾部，并可选地用 spill 文件恢复完整流；子进程从清理后的环境起步；dispose（资源释放）会终止并等待每棵仍在运行的进程树退出。

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

把提供方与它的消费方挂载在同一组合中，并完全按子进程服务的规定启动进程；本包只决定这些进程在宿主机上如何运行。在 Windows 上，非终端子进程与 `taskkill` 辅助进程会隐藏窗口，因此后台操作不会抢占焦点。遵循进程启动可见性设置的 GUI 窗口也会被隐藏。

### 挂载提供方

在与消费方相同的组合中加载本提供方。它没有任何配置字段：每项选择都随 spawn 请求到达，因此随部署变化的决策留在调用方的配置里。

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-bash-local'
```

### 解析可执行文件

绝对可执行文件路径会被验证；裸名称根据清理后的 PATH 并以平台感知的可执行文件扩展名（Windows 上为 `.COM`/`.EXE`/`.BAT`/`.CMD`）解析。含分隔符的相对路径会被拒绝——请提供绝对路径或裸 PATH 名称——相对 PATH 条目从宿主进程 cwd 解析。

### 收集输出

收集模式在内存中保留一条流的最后 `maxBytes`——错误与最终结果通常聚集在末尾——并在配置了 `spill` 上限时把完整流追加到 OS 临时目录下每进程目录中的私有文件（`0700` 目录、`0600` 随机命名文件）。某条流大于 spill 上限时，会丢弃不完整的 spill，只返回带截断标记的尾部。读取基于偏移量且从不消费，因此后台读取与批量读取在退出前后都可以共存。

### 运行终端会话

`spawnTerminal` 分配真实 PTY 并桥接 UTF-8 文本；你可以检查当前前台进程组并向其发送信号，还可以等待一次 `terminate()`，让提供方仍可观察到的每个会话成员完全停稳。在 Linux 上，精确输入等待要求前台线程的 fd 0 标识 shell 的控制终端，且线程当前的 syscall 正在等待该 fd。如果内核拒绝 syscall 探测，提供方不会报告精确等待，而由上层 PTY 后端使用空闲推断；进程睡眠状态不能作为证据。在 Windows 上，SIGINT 以 Ctrl-C 输入写入投递，SIGTSTP 与 SIGHUP 不受支持，拆卸会通过进程表验证 shell 已终止，因为被外部终止的 shell 可能永远不会触发 PTY 退出通知。

### 关闭行为

正常 dispose 会终止每棵仍在运行的进程树与终端并等待其退出。在 JavaScript 可观察的宿主退出期间——直接 `process.exit()`、默认未捕获异常、默认未处理 rejection——同步最终清理会强制终止所有仍归本包所有的对象（对进程组发送 SIGKILL，Windows 上运行 `taskkill /T /F`），且不创建任何 Promise 或定时器。同一退出阶段会删除每进程私有 spill 目录（仅当其未持有任何已完成的 spill 文件时；已完成的 spill 文件作为完整输出恢复产物保留，直到外部机制清理）。未处理的 `SIGTERM`/`SIGINT`/`SIGHUP`、`SIGKILL`、fatal OOM、native crash 与断电则需要外部 supervisor。

### 可能出错的地方

无法解析的可执行文件会以稳定的错误快速失败；从未启动成功的 spawn 会让 `done` reject。越过保留尾部的读取是 `lossy` 的，并在 spill 文件存在时指向它。脱离进程树或终端会话的 daemon 化后代可能比清理更长寿——见下文限制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

本提供方把进程树视为生命周期单元。POSIX 子进程以 detached 方式 spawn（拥有独立进程组），因此整棵进程树以负进程组 id 发送信号，并以直接子进程作为回退；Windows 通过 `taskkill /T` 按根 pid 终止。信号发送、升级与拆卸都以进程树存活状态为守卫，而非以直接子进程结算为准，因此拦截 TERM 的辅助进程无法在无人察觉的情况下比句柄更长寿。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务接线：存活句柄集合、dispose、宿主退出最终清理、可执行文件查找 |
| [`src/spawn.ts`](src/spawn.ts) | 进程管道：detached spawn、保尾收集、spill 文件、升级、进程树退出观察器 |
| [`src/terminal.ts`](src/terminal.ts) | `node-pty` 终端句柄：前台检查、会话清理、Windows 拆卸 |
| [`src/process-inspector.ts`](src/process-inspector.ts) | POSIX 进程树与会话检查 |
| [`src/windows-inspector.ts`](src/windows-inspector.ts) | 经 koffi 的 Windows Toolhelp32 进程表检查 |
| — | 不发布运行时不变式伴生入口；约定归 seam 所有。 |

### 主流程

一次 spawn 会构建清理后的子进程环境、启动 detached 进程、把收集器挂到收集模式的流上，然后返回句柄。`done` 在进程关闭后、经过一段有界管道排空宽限期才结算，因此继承了管道的存活后代无法无限期拖住结果；升级定时器在直接子进程结算后依然存活，使 SIGKILL 仍能到达进程树幸存者。终端清理按精确身份清扫后代、停止 shell、再次清扫，并通过进程表验证其已不存在。

### 安全不变式

spill 文件以 `0600` 权限、`O_EXCL` 与随机名称在 `0700` 每进程目录下创建，可抵御共享临时目录中的符号链接植入；最终关闭失败时不公布 spill 路径。进程身份携带启动时间，因此清理绝不会跟随 PID 复用。宿主退出最终清理不创建 Promise 或定时器，保留宿主退出码与诊断，分别包含每个目标的失败，也不会声称已经完全停稳。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当提供方级约定不够用时阅读以下页面。它们从穷尽式类型参考逐步进入抽象约定，以及宿主机制背后的决策。

- [子进程子系统](../../../docs/subsystems/subprocess.zh.md)——spawn spec、输出读取器、结果与完整的 `DSH_*` 环境。
- [dsh-subprocess](../subprocess/README.zh.md)——本提供方实现的抽象约定。
- [dsh-bash-local](../../shell/bash-local/README.zh.md)——最大的消费方及其请求的具体 stdio 形态。
- [subprocess seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-26-subprocess-seam.zh.md)——进程部分为何成为独立的 seam。
- [同步子进程退出清理](../../../.agents/notes/implemented/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)——宿主退出最终清理决策及其失败模式。

-----

<a id="model-experience"></a>
## 模型体验

通过消费方 seam（例如 bash 执行器家族）间接影响，它们负责所 spawn 进程的输出与生命周期的全部面向模型渲染。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用平台对比或任务积压。

- **Windows 进程树支持仅为尽力而为**——终止经由 `taskkill /PID <pid> /T /F` 完成，所有结果都被就地吸收（进程树已不存在、竞态、二进制缺失），存活探测则回退到直接子进程边界。
- **Windows 终端信号是控制台级的**——SIGINT 以 `\x03` Ctrl-C 输入写入投递，由 conhost 转为控制台级 CTRL_C 事件；SIGTSTP 与 SIGHUP 因不可用而被拒绝；不带 `/F` 的 `taskkill` 无法终止控制台进程，因此拆卸的 TERM 档是 `/F` 升级前的宽限等待。
- **守护化的终端后代仍可能逃出可观察边界**——在 macOS 上，子进程如果在任何前台检查快照之前重新设定父进程，将无法再从 PTY 根进程发现；在 Linux 上，调用 `setsid` 的子进程会同时离开进程树与自有终端会话；本提供方不新增持续进程表监视器。
- **进程内清理要求退出阶段仍能执行 JavaScript**——直接 `process.exit()`、默认未捕获异常和默认未处理 rejection 会发出 Node 同步 `exit` 事件；未处理的 `SIGTERM`、`SIGINT` 或 `SIGHUP`、`SIGKILL`、fatal OOM、`process.abort()`、native crash 与断电，都需要外部 supervisor、容器 init 或等价的 OS 所有者负责。
- **凭据清除依赖名称启发式规则**——只匹配 `*KEY*`/`*PASSWORD*`/`*SECRET*`/`*TOKEN*`；名称不同的 secret（例如 `*PASSPHRASE*`）会继续传递，对误删变量引入白名单属于已记录的后续工作。
- **不会删除已完成的 spill 文件**——有界的完整输出恢复文件会在 OS tmpdir 下累积，直到外部机制进行清理；每进程私有 spill 目录仅在未持有任何已完成 spill 文件时于 JavaScript 可观察的退出阶段删除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
