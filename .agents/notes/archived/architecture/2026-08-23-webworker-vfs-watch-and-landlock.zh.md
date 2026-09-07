# Agent Note: Web Worker VFS 监听与 CLI 兼容 confinement

Status: implemented
Archived: 2026-09-04

[English](2026-08-23-webworker-vfs-watch-and-landlock.md) | 中文

## Problem

Web Worker preview 启动与 Node host 相同的 Web profile 和 Agent preset。缺少 VFS 变更源时，拒绝 `node:fs.watchFile` 会让 `skill-filesystem` 返回不完整观测并在每次查询时重新扫描，而无事件的成功调用会让已有根永远等待 Chokidar 的 `ready`。Settings 和 credentials 同样需要真实的外部编辑事件，而不是包专用 fake。

同一组合挂载 `sandbox-local`，其 Linux 选择链依次探测 bwrap 和 `@deepseek-ai/node-addon-landlock-run`。Worker 无法执行这两个二进制文件。如果选择链到此结束，`workspace-write` 与 `read-only` 将不可用，尽管 shell 的每项文件系统操作已经经过 Host 侧 VFS 调用点。

文件系统兼容边界遵循 [Worker Node face 决策](2026-08-20-webworker-node-face.zh.md)：纯 JavaScript watcher 包在 Node 兼容模块之上保持原样运行。Native 或 binary 包可以保持公开 JavaScript API 与可执行文件协议，同时替换执行后端。无法维持调用方可见 Node 行为的 API 继续明确标记为不可用；`node:vm` 不属于本决策范围。

## Decision

### VFS mutation source 与文件 watcher

`MemoryVfs` 向任意数量的订阅方发布已提交的 `write`、`mkdir`、`remove` 和 `chmod` mutation。状态改变后才发布，失败操作不发布，镜像 seed 保持无事件，一个抛错的订阅方也不能让文件系统操作失败或阻止其他订阅方。Rename 被表达为源路径删除与包含完整状态的目标 mkdir/write 记录；目标 write 会标记目录项已改变，因此 watcher 报告 `rename`，未来的 durable sink 同时拿到物化目标所需的字节。目录的直接条目集合改变时，其 mtime 会推进，因此 polling 能像 Node 一样发现子项创建和删除。

Mutation record 与 WebFS 持久化共用，而不建立第二条通知路径。Write 记录携带提交后的完整字节与虚拟权限位，并在只有尾部变化时携带 append offset。`MemoryVfs` 接受可选的异步 `VfsMutationSink`，把同一批记录交给 sink 与实时 watcher 订阅方，并通过文件句柄的 `sync()` 和 `datasync()` 暴露 `flush()`。水合通过显式的 `{ mode, mtimeMs }` 传入元数据，因此镜像权限与持久化时间戳不会占用同一个位置参数。本次变更不挂载 durable sink；同步内存树继续作为权威，因此 OPFS 或用户目录 mirror 可以先水合、再异步写回，而无需改变 `node:fs`。

`node:fs` 实现 callback `stat` 和 `lstat`、`watch`、`watchFile`、`unwatchFile`、`FSWatcher` 与 `StatWatcher`；`node:fs/promises.watch` 提供可由 abort 取消的异步迭代器。同一路径的 listener 共享一个 `StatWatcher`，按 listener 取消监听不会影响其他 listener；缺失路径先报告零值 Stats，随后再报告创建、删除和重建状态。Callback 分发捕获注册时的异步上下文，并在每次排队交付前检查 watcher 是否已经关闭。预先 abort 的 callback watcher 先返回对象、再异步关闭；预先 abort 的 promise watcher 在第一次读取 iterator 时以 `AbortError` 拒绝。

`fs.watch` 把条目创建、删除和 rename 目标映射为 `rename`，把内容或 mode 变化映射为 `change`。非递归目录 watcher 报告直接子项名，递归 watcher 报告相对被监听目录的路径。VFS 没有符号链接，因此该实现不会制造符号链接事件。

### Stream 与未修改的 NPM 包

`node:stream` 使用维护中的 `readable-stream` 浏览器实现来提供 `Readable`、`Writable`、`Duplex`、`Transform`、`PassThrough`、pipeline helper、异步迭代、backpressure、abort 和 teardown 顺序。兼容模块把字节流 high-water mark 默认值设为仓库 Node 22+ 引擎使用的 64 KiB。VFS 支持的 `ReadStream` 与 `WriteStream` 提供文件描述符、闭区间范围、encoding、追加或替换行为、字节计数、AbortSignal 处理，以及 `open`、`ready`、`finish`、`end`、`close` 顺序。Descriptor 在 rename、replacement 和 unlink 后仍保留打开时的文件身份与访问模式；hard link 共享该身份及后续内容和 mode 变化，truncate 增长则用零字节填充。

Chokidar 和 readdirp 作为普通镜像依赖运行，不属于模块 replacement。它们的包代码保持原样，并导入 Worker 实现的 `node:fs`、`node:fs/promises`、`node:stream`、`node:events`、`node:path` 与 `node:os`。因此，初次扫描、`ready`、polling、原子写归一化、写入稳定等待、共享 watcher 与关闭行为仍由 Chokidar 自己负责。

### 基于逐进程 VFS 授权的 Landlock CLI

`@deepseek-ai/node-addon-landlock-run` 是普通镜像依赖，不是模块 replacement。其未经修改的 JavaScript 入口通过 Worker 实现的 `node:child_process`、`node:module`、`node:path` 与 `node:url` 运行，因此该包仍是 `LAUNCHER_BIN`、`LAUNCHER_FAILURE_EXIT`、`launcherPath()`、`grantArgs()` 和 `probe()` 的唯一所有者。镜像可以包含匹配的 Linux optional package，但包解析不决定 Worker 平台是否提供 Landlock；缺少该 optional package 时，入口包产生的确定性 fallback 路径仍到达同一个平台可执行文件实现。

进程层持有按逻辑可执行文件名识别的 Worker 平台可执行文件表，而不依赖某一个包管理器路径。其 `landlock-run` provider 接受裸命令或绝对 launcher 路径，解析 native 包未经修改的 CLI、校验每个授权根，并把内部 argv 交给既有 shell 进程 runner。`node:child_process` 只负责通用的可执行文件查找、输出投递与结束处理。因此，原包的同步 `probe()` 会通过 `spawnSync` 观察到该 provider 并报告 `full`。用法错误、缺失的授权根或未知内部可执行文件只输出一行 `landlock-run: ...`，以 `125` 退出，并且绝不运行内部命令。bwrap 仍探测为不可用，因此未修改的 `sandbox-local` Linux 选择链会选中该 Landlock 后端。

每个已启动进程分别获得一个 `ShellFileSystem` guard。`stat`、`list` 和 `readText` 需要只读或读写授权；`writeText`、`mkdir` 和 `remove` 需要读写授权；`rename` 要求源和目标都可写。Grant root 在 containment 检查前去除尾部分隔符。拒绝错误包含 `EACCES` 与 `permission denied`，从而保持 `bash-sandbox` 的拒绝分类。`/tmp` 映射到 VFS 的 `/dsh/tmp`，`/dev/null` 则是空读、丢弃写入且不保存任何字节的虚拟文件。

Worker 的 `full` 结论覆盖 shell 命令表和 Host 服务 VFS 协议能够表达的全部文件操作。它不表示 Linux 内核 Landlock、不支持任意 native 可执行文件，也无法约束未来绕过 `ShellFileSystem` 的 shell 程序。

### 明确延后的行为

`node:vm`、`node:worker_threads`、`node:net`、`node:sqlite`、native PTY、Sharp 和 ripgrep 不属于本次变更。VFS 仍然只支持 POSIX、内存存储且没有符号链接。Browser Worker 没有 libuv 风格的引用计数事件循环，因此 watcher 的 `persistent`、`ref()` 和 `unref()` 保留 API 与可观察状态，但不能决定 Worker 生存期。

## Alternatives considered

**在 Worker profile 中禁用 watcher 与 sandbox 配置项。** 缩减组合后将不再测试相同的 Host tree，还会隐藏 preview 部署特有的包集成故障。

**让 `watchFile` 成为无事件的成功调用。** 缺失根永远无法推进，已有根则会永久等待 Chokidar `ready`。

**只从 `node:fs` 通知 watcher。** Shell 进程请求以及直接写 VFS 的实现可以绕过通知点。只有提交状态的 `MemoryVfs` 才是完整真源。

**保留 VFS 专用的 Chokidar replacement。** 这会重复实现上游已经维护的目录扫描、ready 计数、写入稳定等待、原子替换、共享 watcher 所有权和 teardown。

**用 Worker 模块替换 Landlock 入口包。** 重新实现其导出常量、授权参数构造、launcher 解析和 probe，会为一个已经能在 Worker Node 兼容层上运行的包约定建立第二份副本。只有平台可执行文件实现需要不同。

**只识别一个精确 launcher 路径。** Optional dependency 的安装状态与入口包已有的 fallback 会为同一个可执行文件产生不同的绝对路径。包管理器布局不是平台能力的身份，因此可执行文件分发使用逻辑名称 `landlock-run`。

**在 `sandbox-local` 中增加 Worker 分支。** 这会把策略到授权的映射复制到业务包中。解释现有 launcher 协议可以保持 provider、consumer、配置、诊断和 native 包 API 不变。

**在全局 VFS 上保存一个当前策略。** 并发前台、后台和升权命令会覆盖彼此的权限。授权必须归属于单个进程句柄及其文件系统适配器。

## Verification

- `fs-watch-stream.spec.ts` 对照当前 Node 版本验证缺失、创建、修改、删除的 `watchFile` 状态转换，以及文件流生命周期、分片、范围、backpressure、字节计数、默认值和 abort 身份。
- `chokidar.spec.ts` 通过 Worker transformer 与模块 loader 加载 lockfile 选定的两组 Chokidar 和 readdirp 依赖，并在 `MemoryVfs` 上验证 `ready`、callback watcher、polling、缺失文件创建、删除和完全停稳的关闭。
- `image-loadable.spec.ts` 打包并加载真实的 `@deepseek-ai/node-addon-landlock-run` JavaScript，验证它不在 replacement 表中，并让其 fallback `launcherPath()` 与 `probe()` 经过 Worker 平台可执行文件。`child-process.spec.ts` 与 `sandbox-stack.spec.ts` 随后通过生产 sandbox 和 subprocess 包验证 launcher 失败码、错误 argv 与授权失败、`/tmp` 与 `/dev/null`、rename 拒绝、三种权限模式和逐进程并发授权。
- `preview-boot.e2e.ts` 构建并启动打包后的浏览器部署，创建 Workspace 与 Session，把缺失的 skill 根逐级推进到可用的 Chokidar watch，读取 catalog，并在没有 watcher 警告的情况下完成 settings 与 credential 写入。

## Consequences

Preview 现在可以在不 fork 源码的情况下运行 NPM watcher 消费方；Host 代码与 shell 进程 Worker 产生的文件系统 mutation 共享同一个有序提交源。WebFS/OPFS 集成仍是围绕该同步权威的异步 mirror，并消费同一个变更源；它不会增加另一份 Chokidar 实现或互相竞争的 mutation 协议。

Worker `read-only` 与 `workspace-write` 在不 fork Landlock NPM 包的情况下保留产品权限词汇和拒绝报告。其安全结论比 native Landlock 更窄，但完整覆盖 Worker 执行世界；任何新的文件系统消息或 shell 程序都必须继续经过受 guard 保护的 `ShellFileSystem`。Native-backed 包遵循同一所有权规则：其 JavaScript 保持上游实现，Worker 平台只替换背后的 native artifact。

Worker bundle 增加 `readable-stream` 及其少量浏览器依赖。相应地，stream 状态和 backpressure 继续由上游维护，不成为本地兼容代码。

Watcher 事件时序由 VFS 提交确定，而不是继承操作系统后端。Node watcher 约定本身不保证 native 事件合并方式，因此该实现仍符合约定；测试固定当前消费方依赖的每一种事件区别。
