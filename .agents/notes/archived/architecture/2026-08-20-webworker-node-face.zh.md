# Agent Note: worker 的 Node 面——builtin、VFS 与 shell 进程层

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-webworker-node-face.md) | 中文

## 问题

worker 逐字节运行 web profile 的 Cordis 配置——没有 worker 专属行——因此浏览器缺失的平台必须在模块层被替换：被代理的模块保持身份、更换实现。这覆盖三条战线：树所 import 的 Node builtin、这些 builtin 背后应答的文件系统，以及 bash 工具的进程层。如果 `node:child_process` 只是结构桩，工具仍会照常挂载并向模型自我宣告，但每次调用都会失败。

## 决定

**Builtin。** 代理表只替换 Node builtin 与外部 npm 包，绝不替换 workspace 或 vendored 模块。`./implemented/<module>.ts` 在 worker 数据源之上承载真语义；`./mock/<module>.ts` 静默挂载、在调用真正抵达时报告缺失的能力。装载器的表按 specifier 各持一个 memoized thunk——求值发生在首次 `require` 而非装配期——且每个垫片的导出面对 Node 自身的模块类型作类型检查，仅在结构身份（真实类）确不可满足处留最窄的、有说明的例外。它的 `createRequire` 面在镜像 package 根之上同时提供 `resolve()` 与 `resolve.paths()`，使未修改的包无需加载目标即可发现 manifest。`process` 全局由 worker 自装，装配期填入表中。Shim 包含 `process.title`：`@xterm/headless` 等包通过该属性是否存在来选择 Node 路径；缺少它会让 dedicated Worker 被误判为浏览器 Window，进而访问仅适用于 DOM 的全局对象。

**VFS。** 内存为真相。`statSync(path, { bigint: true })` 返回 Node 的 BigInt 形状，其中两个字段承载真实信息，因为 `dsh-fs-local` 的 stale-write guard 依赖它们：`ino` 是按路径的身份（单调计数器分配，路径重建即新身份），`mtimeMs` 按条目严格递增（`max(now, previous + 1)`）——内存写例行落在同一毫秒内，相等的时间戳会放过陈旧覆写。已提交的 mutation 还会驱动 [Node 兼容 watcher 与 confinement 实现](2026-08-23-webworker-vfs-watch-and-landlock.zh.md)。Cordis 日志器的详细度数值向上计数，因此 `startWorkerHost` 会在任何 entry 挂载前安装 `levels: { default: 2 }` 的 console exporter，避免未声明等级的 exporter 丢掉所有 warning。

**Shell。** `node:child_process` 是 VFS 之上的真实现。语法是买来的——`@yarnpkg/parsers` 的 `parseShell`——求值器与命令表是自有的，因为每个候选解释器都自带文件系统：管道是逐段传递的字符串，每个程序是 VFS 上的一个函数。普通命令从该表解析；native 包协议可以通过 [watcher 与 confinement 决策](2026-08-23-webworker-vfs-watch-and-landlock.zh.md)提供 Worker 自有的虚拟 executable wrapper。两处都没有的名字在直接 spawn 时报告 `ENOENT`，在 shell source 中则报告 `command not found`（127）。每次 `spawn` 从同一个 bundle 起一个子 Web Worker，首帧声明 shell 进程角色，因此终止梯是真的：`SIGTERM` 在下一命令边界处请求停止，`SIGKILL` 在任意时刻终止 worker——这是线程内解释器永远没有的抢占。文件系统面端到端异步（子进程经帧到宿主 VFS）；`execSync`、`execFileSync`、`fork` 拒绝，`node-pty` 保持桩。

## 曾考虑的替代方案

**整包替换 `dsh-subprocess-local` 或替换 bash 执行器。** 前者让代理表首次替换 workspace 包、违背其自身分类并倒置分层；后者撞上 `dsh-permission-presets` 对 `sandboxMode` 的 boot 期硬校验，并丢掉执行器已被测试钉住的超时/输出行为。

**`@yarnpkg/shell`、WASM shell、WebContainer。** 配套解释器建立在真实 Node streams 之上（约 1.5 MB 闭包要自养）；本部署排除 WASM，WASI 没有 `fork`；且它们全都自带文件系统——恰是无法复用的那部分。

**`SharedArrayBuffer` + `Atomics.wait` 给子进程同步文件系统。** 在部署目标实测：无 COOP/COEP 头时 `SharedArrayBuffer` 未定义，而 GitHub Pages 无法设置响应头。异步面是超集；SAB 后端将来可垫入其下而不动任何程序。

**伪造 stats 或放宽错误谓词，而非如实实现 `bigint`。** 常量 `ino`/纯挂钟 `mtimeNs` 会静默废掉 stale-write guard；让技能发现吞下 `FS_IO_ERROR` 则会把同一个 bug 变成处处无失败的永久空目录。

## 后果

- `read-only` 与 `workspace-write` 解释 native Landlock launcher 协议，并在 VFS 帧闸口执行逐进程授权；`danger-full-access` 保持直接进程路径。[Watcher 与 confinement 决策](2026-08-23-webworker-vfs-watch-and-landlock.zh.md)拥有该执行世界中 `full` 的更窄含义。
- Node 宿主的阶梯测试（`tests/node/child-process.spec.ts`）登记为 windows 不支持：阶梯的 win32 kill 梯级是按真 pid 的 taskkill，对进程表 pid 不可投递，而 worker 自身恒报 `linux`。
- 输出增量但不流式：程序写入的 sink 以 `data` 事件转发，一个管道阶段完成后下一阶段才开始。
- `tests/node/process-shim.spec.ts` 独立于测试运行器自带的 Node process，钉住 Node 环境识别字段。
- 运行时的测试镜像 `src/`（`tests/node/`、`tests/shell/`、`tests/storage/`……），每个垫片族在 oracle-diff 套件旁拥有自己的行为用例。
