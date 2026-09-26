# Agent Note：唯一的 shell execute()——前台是投影，超时是对 job 的有界等待

状态：已实现

Update：[jobs seam 收敛](../architecture/2026-09-03-jobs-seam-consolidation.zh.md)拥有每条已登记命令现在填充的输出环、游标与拉取源。

[English](2026-08-26-shell-execute-projection-and-jobs-at-start.md) | 中文

## 问题

跑过前台超时的 bash 命令会被杀掉、工作作废——这是长构建或安装在 agent 手里失败的头号方式。在旧 seam 里修它结构上很别扭：`ctx.shell` 有两个执行方法，`run()`（deadline 内置、只给 promise、没有可保留的句柄）与 `start()`（有句柄、无 deadline），于是「保住这个已在运行的前台命令」无从表达——deadline 的所有者只会杀，调用方也拿不到可向 `ctx.jobs` 重新注册的东西。两个方法还各自漂移：stdout 预算不同、文档里挂着「start 忽略 timeoutMs」的疣、同步与异步 spawn 失败的行为按路径分叉。

同行证据指向同一个方向。Kimi 默认让超时的命令继续运行（`bashAutoBackgroundOnTimeout`），什么都不重绑——进程任务脱离、调用方信号解钩、部分输出随句柄返回。Claude Code 的超时处理对同一个 `ShellCommand` 调用 `background()` 而不是杀掉，并明确注释重新 spawn 会泄漏清理并重复事件。Codex 根本没有移交，因为它从未有过「前台 spawn」：每次 `exec_command` 都是对一个 session 的有界观察窗，「仍在运行」是携带句柄的正常返回。三家在底层形状上一致：执行只有一种方式，前台是等待的属性，不是 spawn 的属性。

本变更最初交付的版本把移交放在了 seam 上：`onExpiry: 'offer'` 策略、`ShellExecution.promotion`，以及工具必须在 deadline 处同步应答的 `ShellPromotionOffer`。评审否决了它：这套协议存在的唯一原因是工具把 job 登记推迟到了超时点而不是启动点，于是每个执行器都要背一条中继/计时/解绑分支，每个消费方都要背一条任何执行都不需要的时序义务。

## 决策

**seam 收敛为 `resolve()` + `execute()`。** `execute(spec)` 返回 `Promise<ShellExecution>`——活的 `ShellProcess` 本体加前台投影 `result()`（分流收集、首因 `timedOut`/`aborted` 归类、只为基础设施失败 reject）。`run()` 与 `start()` 删除（pre-release，无垫片）；它们编码的历史差异变成显式输入：`ShellExecSpec.onExpiry` 取 `'kill'`（默认）或 `'none'`，stdout 预算统一为 `spec.stdoutMaxBytes`。没有任何移交协议：只想等一段时间的调用方以 `'none'` 运行命令并自己限定等待时长，调用方停止等待后句柄依然有效。

**准备与执行共用 deadline。** 异步沙箱准备完成后才发布句柄。准备期间的取消或失败会拒绝 `execute`；到期则返回已结算的超时句柄，输出为空。迟到的准备结果不会启动任务。提供方事实在 subprocess 结算前同步安装，立即失败的启动也能获得对应的沙箱归类。

**spawn 失败统一收容**：同步抛错与异步 rejection 都把句柄结算为 `killed`、说明进入读路径，而 `result()` 以原始错误 reject（保留同一性——沙箱执行器在其 `result()` 装饰里把可归因于 runner 的失败映射为 `SANDBOX_UNAVAILABLE`，并在 `onProcessDone` 里盖章句柄事实，两者都以同一个句柄实例为键）。

**组合中有 job 注册表时，`tool-bash`/`tool-pwsh` 在每条命令启动时就把它登记到 `ctx.jobs`。** `run_in_background` 立即返回 id。前台调用启动同样的 job，并用注册表的 `wait(id, timeoutMs, owner, signal)` 等待它，等待上限就是现有的 `timeoutMs`——没有第二个旋钮。在等待内结算的命令用句柄的 `result()` 返回普通前台结果，工具随即移除该 job 记录（`JobRegistry.remove`），模型从不看到 id，列表也不会堆满每一条 `ls`。超过等待仍在运行的命令继续作为它本来就是的那个 job 运行，调用返回 `{ kind: 'promoted', jobId, timeoutMs, output }`——渲染为 `[still running after <ms>; moved to background job <id>]` 加交接指引——并以一次消费式注册表读取打底，因此 `job_output` 恰好从此处接续。超时那一刻没有任何东西易手：进程没有、中止信号没有、输出也没有。工具从不把自己的信号交给进程；取消调用会杀掉 job，而来自调用之外的杀停（人的停止控件、并行的 `job_kill`）经 job 的 `cancel` 钩子到达进程，工具把其原因渲染为前台结果里的 `[stopped: <reason>]`（值上的 `stopped`），模型读到的是原因而不是命令失败。

**后台能力面跟随注册表，注册表保持可选。** 工具的 `inject` 不写 `jobs`。没有注册表时它注册纯前台定义；`ctx.jobs` 出现后，`ctx.inject(['jobs'], …)` fork 用带 job 的定义替换它，注册表存在多久就保持多久；注册表在插件仍在时卸载，则恢复纯前台定义。因此没有注册表的组合保留一个 schema 既不宣传 `run_in_background` 也不宣传移交的普通 `bash`，模型也看不到任何 `job_*` 工具。登记是尽力而为的：`promoteOnTimeout: false`，或注册表在启动时拒绝该 job（持有者的准入上限、没有已附加的控制器），都改为在执行器的 `'kill'` deadline 下运行命令，并记录日志。

**注册表报告等待方已经收走了什么。** `settled` 事件带 `awaited`：本次结算是否释放了一个存活的 `wait`，工具等待自己的前台命令时为真，`job_output` 的等待亦然。`dsh-tool-jobs` 对已 awaited 的结算和模型经 `job_kill` 请求的杀停不发完成通知，其私有的认领台账已删除；超时或中止的等待早已离开注册表的等待方集合，之后的结算照常通知。来自 web 控制器的人类杀停两者都不是，因此拥有者 agent 照常收到带原因的通知。

## 备选方案

- **在 `run`/`start` 旁加第三个方法（`begin()`）**——最初的设计。评审中否决：三个「方法」其实是披着方法名的两根正交输入（deadline 策略；调用方等待哪个投影），同行产品全都建模为一次执行加投影视图。收敛顺带删掉了预算/疣的漂移，而不是再添一层表面。
- **Codex 的 session 模型**（每次调用都是观察窗、经 `write_stdin` 轮询）——否决：那是重复 `ctx.jobs` 已有能力的模型侧词汇变更；其早退结果契约保留在 promoted arm 里。
- **独立的移交阈值配置**——否决；「超时意味着别再阻塞回合，而不是杀掉工作」不需要第二个计时器，模型显式传的 `timeoutMs` 同样限定等待（两家同行皆如此；schema 文案已说明）。
- **seam 上的转移 offer**（`onExpiry: 'offer'`、`ShellExecution.promotion`、需同步 `accept()`/`decline()` 应答的 `ShellPromotionOffer`）——本 PR 最初交付的版本。评审否决，因为推迟登记是这套协议存在的唯一原因：执行器的 offer 分支中继调用方信号、自设计时器、accept 时解绑信号，这些持有句柄的消费方都能自己做，而 job 一开始就存在后一样都不需要。
- **不在启动时登记、只由工具在 `onExpiry: 'none'` 之上自设 deadline**——去掉了 seam 协议，但命令在超时前依然不可见、不可杀；否决，因为从第一秒起就被列出、可停止的命令正是人类杀停的意义所在。
- **shell 工具硬依赖 `jobs`**——否决：想要 shell 却不想让模型看到三个 `job_*` 工具的组合必须仍然可能，所以工具改为随注册表的存在切换定义。
- **让被等待的命令不占准入名额，以及 `JobView` 上的 `attached` 标记**——延期：启动时被拒回落到 deadline 杀，Web 任务列表对运行中前台命令的分组留作后续。

## 测试

执行器层（真实进程）：`'kill'` 与 `'none'` 两个分支按首因归类；deadline 前的调用方 abort 在进程活过 deadline 时仍是首因；预先 abort 的信号归类 `aborted`；准备到期返回已结算的超时句柄且不 spawn（沙箱套件）；同步抛错收容且错误同一性穿过 `result()`。工具层：真实的 `printf …; sleep 30` 配 `timeoutMs: 250` 在调用等待期间就以 `bash-1` 列出，返回带早期输出的仍在运行文本，其下一次 `job_output` 读取不重复任何内容；在等待内完成的命令返回前台结果，注册表依次播报 `registered`、`settled`（`awaited: true`）、`removed`，之后列表为空；等待期间的注册表杀停在信号标记前渲染 `[stopped: cancelled by the user]`；取消调用以 `tool call aborted` 为原因杀掉其 job；启动失败是工具的错误结果且不留 job；准入饱和回落到 deadline 杀并告警；`promoteOnTimeout: false` 保持杀、不发任何 job 事件、撤掉描述句；注册表稍后加载时 schema 切到带 job 的版本、卸载时切回纯前台，而在注册表存在时释放工具插件会移除工具且不记录任何错误；pwsh 以脚本化执行器镜像每个用例。注册表层：存活等待为 `awaited`，无人等待、超时或中止的等待为 `false`，另一个等待超时时仍为 `true`；`remove` 以 `removed` 事件丢弃已结算记录，并拒绝存活 job、未知 id 与外部调用方。渲染文本逐字钉死。

## 后果

- 每个 `ShellExecutor` 消费方都已迁移：工具、hook runner、tmux-context 与 webworker 沙箱栈现在都说 `execute()`；执行器测试套件用本地 `run`/`start` 垫片保住场景语义。
- `bash`/`pwsh` 的工具描述与 `timeoutMs` schema 文案取决于注册表是否存在（模型可见）；输出 union 保留 `promoted` arm，前台 arm 新增可选的 `stopped` 原因——PTC 系统提示词快照随之重录。
- 已登记的命令完全没有 deadline：前台调用的超时只限定等待，之后停下命令靠 `job_kill` 或 Web 停止控件。
- Web 任务列表显示每条运行中的前台命令并经 `job.list`/`job.follow` 流式观看；完成的命令随结果离开。
- `JobRegistry` 新增 `remove` 与 `settled` 事件的 `awaited` 标志；`dsh-tool-jobs` 只保留模型杀停过的 job 集合。
- `start()` 时代同步 spawn 抛错逃逸给调用方的行为不复存在：调用方从 `result()`/读路径读失败。沙箱「同步 EACCES 指名 runner」的分类现在以 `result()` rejection 或句柄的 `runnerFailed` 事实呈现。
