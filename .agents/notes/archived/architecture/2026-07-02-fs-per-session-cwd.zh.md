# Agent Note: 相对文件系统路径按调用方的会话 cwd 解析

Status: implemented
Archived: 2026-09-04

[English](2026-07-02-fs-per-session-cwd.md) | 中文

## 问题

ACP（Agent Client Protocol）桥接层为每个会话提供独立的工作区：`session/new` 将自动化客户端的项目目录记录为 `SessionHeader.cwd`，`dsh-tool-bash` 将每次 bash 调用的 `workdir` 默认设为调用方 agent（智能体）的 `session.header.cwd`（见 [ACP 包](../../../../packages/acp/acp) 与 `dsh-tool-bash` 中的 `resolveWorkdir`）。因此会话 A 中的 bash 命令在 A 的项目目录执行，会话 B 中的在 B 的项目目录执行——一个服务器进程，N 个工作区。

文件系统解析使用的是插件加载时的 cwd，而 bash 使用的是会话的项目目录。因此，当自动化客户端的项目目录与服务器启动目录不同时，相对路径的解析结果就会不一致；快照测试因为让这两个路径相同而掩盖了这个 bug。

一个有效的绝对 cwd 本身可能看起来有两个父目录：当它包含 `symlink/..` 时，文件系统查找会先跟随符号链接再应用 `..`，而 `path.resolve()` 会从词法上抹掉这两个组件。如果用词法解析沙箱策略却从原始 cwd 启动 bash，就会把权限授予无关的词法父目录、拒绝真实工作区内的写入，并让文件系统工具把相对路径解析进错误目录。

普通的符号链接 cwd 在请求的相对路径包含 `..` 时也暴露同一区别：进程从符号链接的物理目标开始遍历，`path.resolve(cwd, path)` 却从其词法拼写开始遍历。因此，对于同一个模型提供的路径，read 所选文件会不同于 bash 或沙箱化 mutation 对同一路径所选的文件。

## 决策

将调用方的会话 cwd 传入路径解析，与 `dsh-tool-bash` 对 `workdir` 的处理方式完全一致。当 cwd 或请求路径任一包含父目录段时，在任何词法 join 之前把 cwd 解析为原生文件系统标识；没有遍历会使标识可观察时，则保留普通 cwd 拼写以供展示。mutation 和沙箱化 bash 调用复用解析后的沙箱策略根目录，使一次调用只有一个工作区标识。**调用方**（即工具）提供 cwd；提供方不读取会话或 agent。

- `FileSystem.resolve` 接受 `resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>`。`opts.cwd` 是相对 `path` 解析时的基准目录；绝对 `path` 忽略它；省略 `opts.cwd` 则使用后端自身的默认值。后端执行 I/O 时，`opts.signal` 可以取消解析。options 对象把调用方拥有的两个解析控制项放在一起，避免位置参数继续增长。
- `dsh-fs-local.resolve` 使用 `resolveLocalTarget(opts?.cwd ?? this.config.cwd, path)`。`config.cwd` 仍作为调用方未提供会话 cwd 时的默认值。
- `dsh-tool-fs` 的 `read`/`write`/`edit` 通过共享的 `sessionCwd(exec, requestedPath)` 辅助函数（`exec.agent?.session.header.cwd`，与 bash 的 `resolveWorkdir` 对应）获取会话 cwd，并传给 `resolve`。只要任一值中的父目录段可能跨越符号链接，该辅助函数就使用原生 realpath 语义，否则保留普通拼写；沙箱化 mutation 复用完整策略的 `workspaceRoot`；非 agent／无 header 的调用方得到 `undefined`，后端因此应用其默认值。

## 曾考虑的替代方案

### 为何由调用方（而非提供方）提供 cwd

提供方约定不得依赖 `dsh-agent`／`dsh-session`——这是一项文本存储后端约定，沙箱化实现或远程实现同样满足该约定，而这些实现没有「agent 会话」的概念。工具已经接收了 `ToolExecution`（`exec`），其中携带 agent，因此工具是将 `exec → cwd` 投影并向提供方传递一个纯字符串的正确位置。这遵循「包边界处显式优于隐式」的约定：基准目录作为显式参数传入，提供方据此行动，而非让提供方越界去读取它不应知晓的会话。这也与 `dsh-tool-bash` 一一对应，使两个面向模型的文件操作接口以相同方式解析路径。

默认值只存在于一个地方——提供方的 `config.cwd`。`sessionCwd` 在没有会话时返回 `undefined` 而非 `process.cwd()`，因此工具永远不会自行制造一个提供方本应自行选择的基准目录。

## 后果

- 在 ACP 演示中，fs 工具与 bash 对每个会话的工作区达成一致；自动化客户端可以选择任意绝对项目目录，两类工具都在该目录下操作。
- 对于包含 `symlink/..` 的会话 cwd，或普通符号链接 cwd 搭配含父目录遍历的相对路径，bash、文件系统工具和沙箱授权都会从同一个物理工作区解析；词法父目录不会获得授权。
- `FsTarget` 的标识不变：`targetKey` 仍为解析后绝对路径的 realpath，因此 observed-state 键控与符号链接标识不受影响——正确的每会话 cwd 产生与 bash 目标相同的 key。
- 向后兼容：所有现有的 `resolve(path)` 调用（均在测试中）继续正常工作；新参数是可选的。
- 单会话 stdio 演示不受影响：它不提供会话 cwd（其 agent 的会话没有 `cwd`），因此解析回退到 `config.cwd = process.cwd()`，即工作区本身。
