# Agent Note: 进程服务是 bash 执行器之下的独立 seam（`dsh-subprocess` / `dsh-subprocess-local`）

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-subprocess-seam.md) | 中文

## 问题

`dsh-bash-local` 原先把两项因不同原因而变化的能力捆绑在一起：*运行一条 bash 命令*（命令默认值补全、超时分类、对模型友好的终端环境、bash 工具所渲染的 stdout/stderr 合并）与*运行并管理一个子进程*（detached 进程组、附带 spill 文件的有界尾部保留输出、凭据清除与 `DSH_*` 合并次序、SIGTERM→宽限期→SIGKILL 升级、先终止再等待退出的 dispose（资源释放））。进程这一半（`run.ts`）约占整个包的一半，却没有属于自己的 seam：未来的非 shell 运行器（直接执行 argv 的执行器、worker supervisor）将不得不重新实现这套机制，或者探入 bash 内部；而共享的 `DSH_*`/`CollectedOutput` 词汇则存放在一个名字承诺 shell 语义的包里。这种捆绑还把后台进程的存续期系在执行器的 fiber 上：重载 bash 执行器会杀死每一个存活的后台进程。这一点不同于兄弟的[任务注册表](2026-07-26-job-registry-seam.zh.md)：后者的注册存续期刻意长于生产方 fiber。

## 决策

新的 `subprocess/` 能力家族拥有「运行并管理一个进程」；bash 家族保留「运行一条 bash 命令」，并成为前者的消费方：

- **`@deepseek-ai/dsh-subprocess`（Service Definition）**——拥有 `ctx.subprocess` 的抽象 `SubprocessRuntime`：可执行文件查找、完全显式的普通 spawn，以及[可移植执行环境决策](2026-07-28-portable-execution-world-consumers.zh.md)新增的终端原语。每条 stdio 流独立选择 `'pipe'`、`'inherit'` 或有界收集 `{ maxBytes, spill? }`；stdin 选择 `'ignore'`、`'pipe'` 或 `{ data }`。`SubprocessOutcome` 只承载刻意不含超时／取消分类的退出事实，收集输出在结算后仍留在句柄上。该 Service Definition 还拥有进程与终端句柄、共享凭据清除，以及 `DSH_ENV_PREFIX`/`DshEnvironment`/`CollectedOutput`；`argv` 绝不经过 shell 解释。
- **`@deepseek-ai/dsh-subprocess-local`（Service Provider）**——`LocalSubprocessRuntime` 构建在原 `run.ts` 管道（现为 `spawn.ts`）与 `node-pty` 之上：detached 进程组、有界收集与私有 spill 文件、可执行文件查找、前台／会话检查，以及终止每个受管进程并等待其退出的 dispose。`terminate()` 拥有面向进程树的 TERM→宽限→KILL，`waitForExit()` 观察进程树存活性，可注入的 `taskkill /T` 覆盖 Windows。普通与终端 spawn 都先应用 Service Definition 对 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 不区分大小写的清除，再合并显式 env。该 Service Provider 没有配置；每项限制都随 spec 到达，Bash 与 PTY 的呈现环境覆盖仍归各自 Consumer 所有。
- **`dsh-bash-local`（Consumer）**——`inject: ['subprocess']`；把每个解析后的 `ShellExecSpec` 映射为一个 `SubprocessSpawnSpec`（`['bash', '-c', command]`），并保留自身配置、`resolve()` 默认值补全、基于融合 deadline 的 `timedOut`/`aborted` 分类、带 `[stderr]` 标记的后台读取合并及其消费游标，以及 `onProcessDone` 子类钩子。`dsh-bash-sandbox` 除了重新声明继承来的 inject 之外没有变化；它仍在命令字符串层面做包装，并重新进入继承的 spawn 路径。
- **`dsh-shell`（Service Definition）**——把迁走的词汇从 `dsh-subprocess` 重导出，因此没有任何 bash Consumer 需要改动导入；`ShellExecRequest`/`ShellExecSpec`/`ShellProcess` 与沙箱事实仍归 bash 所有。

每个加载 bash 执行器的组合都同时加载 `@deepseek-ai/dsh-subprocess-local`：CLI（命令行界面）、各示例、Python 捆绑运行时以及各内联测试配置。

后台进程的存续期从执行器移到了服务：执行器不再保有存活进程集合，于是重载执行器后，后台工作会继续运行且仍可读取，而组合拆除（服务的 dispose）仍是先终止再等待退出的边界。一条行为约定随之挪动：后台 spawn 失败不再能在管道内部被缓冲成伪造的 stderr（对一个从未真正运行的进程，服务会 reject `done`，且不缓冲任何内容），因此执行器把 `spawn failed: …` 提示注入恰好一个 `readOutput()` 增量。

基于已观察到的流与生命周期需求，具备条件的进程消费方随后迁到该 seam：LSP 使用管道化协议流加收集式 stderr 尾部；ACP（Agent Client Protocol）后端使用管道化 ndjson、继承式 stderr 和消费方拥有的 stdin-EOF dispose 阶梯；PTY 使用 `spawnTerminal()`，同时保留就绪与终端策略。`dsh-subagent-subprocess` 与 LSP 私有进程树辅助函数均被删除。MCP 传输 spawn 和刻意保持轻依赖的 test-support 启动器因所有权或执行形状仍留在外部；适用的生产调用方共享凭据清除。

## 曾考虑的替代方案

**把进程管道留在 `dsh-bash-local` 里（维持现状）。**否决的理由与[任务注册表拆分](2026-07-26-job-registry-seam.zh.md)得以落地的理由相同：这条边界既稳定，也早已记录在代码里（`run.ts` 的模块文档曾写明「this layer reacts to an abort signal; the executor owns deadlines and classifies causes」），而若继续将它保持私有，未来每个非 shell 运行器就只能要么 fork 这套机制，要么为非 bash 工作去依赖一个以 bash 命名的包。本次变更对用户可见的动因正是这一拆分。

**保留最初只支持批量的接口，让流式消费方继续各自实现。**否决：已观察到的 LSP、ACP 与 PTY 形状表明，这会继续保留重复的私有进程树信号与环境清除。Node 形状的处置方式覆盖这些消费方，又不缓冲管道化流。

**用单个 `stdio: 'pipe' | 'inherit' | 'collect'` 模式统一全部流。**否决：真实消费方按流混用模式——LSP 使用 pipe/pipe/collect，ACP 使用 pipe/pipe/inherit，Bash 使用 data/collect/collect。

**把每一次进程启动都路由到 `ctx.subprocess`。**否决：MCP SDK 拥有其传输 spawn，support 启动器则刻意独立于产品 seam。PTY 分配迁到 `spawnTerminal()`，因为这项底层专用原语归提供方而非消费方所有。

**改把 `run_in_background`/任务语义放进 subprocess 能力 seam。**否决：那条边界已经存在。`ctx.jobs` 拥有 id、所有权与通知，bash 工具则把 `ShellProcess` 适配成任务钩子。subprocess seam 位于 bash 执行器*之下*，而不是与任务注册表并列。

**把 `ENV_OVERRIDES`（TERM=dumb、PAGER=cat 等）移入服务。**否决：通用进程服务不得把终端呈现策略强加给非终端消费方；对环境中凭据形态名称与 `DSH_*` 名称的清除是安全与身份不变式，予以保留，但终端友好性是 bash 工具自己的选择，经 spec 的显式 env 表达，而调用方自己的条目依旧优先。

## 后果

换来的是：「运行并管理一个进程」成为 Bash、LSP、PTY 与 ACP 消费方共用的可替换能力；容器化或远程进程后端可以直接接入，而无需改变各领域语义；进程树信号、升级终止、有界收集、终端机制与凭据清除各自只剩一份实现；后台进程也能在执行器重载后存活，与任务注册表的存续期模型一致。进程与终端管道通过 `dsh-subprocess-local` 测试；消费方测试套件只需针对真实服务固定各自拥有的行为。

代价是：多出一对包，而且凡加载消费方之处都多一行组合配置；缺少 subprocess 提供方时，消费方会按标准服务注入行为保持挂起。每个后端都要实现可执行文件查找、三种 stdio 模式、进程树生命周期和一个终端原语。迁移词汇的重导出让 `dsh-shell` 的导入继续可用，但也意味着两个包命名同一批类型；进程 seam 是所有者。spawn 失败提示经由 Bash 的消费式读取游标变为单次交付，不再是可重复读取的 stderr 缓冲内容。
