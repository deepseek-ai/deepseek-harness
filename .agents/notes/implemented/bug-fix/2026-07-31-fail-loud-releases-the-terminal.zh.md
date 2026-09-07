# Agent Note: fail-loud 在退出前释放终端

Status: implemented

[English](2026-07-31-fail-loud-releases-the-terminal.md) | 中文

## 问题

配置校验失败的 `dsh` 启动会打印诊断信息，然后把用户丢回一个损坏的 shell：输入不可见，下一条命令还会被残留文本弄乱：

```
dsh: fatal load failure: ValidationError: invalid config:
  - $.providers expected object but got [object Object] (at providers)
$ 1;2;4cecho hello
zsh: command not found: 4cecho
```

Loader 并发挂载各个条目，因此条目失败的顺序并不等于启动顺序。`ui-tui` 会先激活并调用 pi-tui 的 `ProcessTerminal.start()`，它把 stdin 置为 raw 模式、启用 bracketed paste，并写出 Kitty 键盘协议探测序列——该序列以一个 Device Attributes 查询（`ESC [ c`）结尾。随后某个同级条目（这里是 `llm-pi-ai`）因自身配置而 rejection。

在当时，该 rejection 以未处理 rejection 的形式浮现，而 `installFailLoud` 只写一行 stderr 就立即调用 `process.exit(1)`。（事务化 Loader 现在让配置树失败经 `boot()` 结算，由它自行 dispose（资源释放）部分构建的上下文；release 钩子仍然守护 `boot()` 看不到的 rejection——插件游离的异步工作在挂载期间或挂载之后失败。）没有任何环节 dispose 这棵树，因此 `ProcessTerminal.stop()` 从未执行：raw 模式、bracketed paste 和键盘协议都残留在比进程活得更久的 shell 上。终端对 Device Attributes 查询的回应（`1;2;4c`）在进程退出之后才到达，被 shell 当作用户输入读入——也就是上面那段字面文本。

`/exit` 路径从不受影响，因为它会 dispose 整棵树，从而进入 TUI 自身的 `shutdown()`：先 `drainInput()`（吸收尚未返回的响应），再 `ui.stop()`。缺陷在于**启动失败**没有通往这同一套拆卸流程的路径。

## 决策

`installFailLoud` 新增可选的 `release` 拆卸回调，在诊断信息与退出之间被等待：

- 诊断信息在 release **之前**写出，因此卡住或失败的 disposer 无法吞掉失败原因。
- 使用闩锁（latch）而非卸载监听器，来保证被报告的始终是第一个 rejection。若在拆卸期间移除监听器，第二个并发 rejection 就会变成未捕获错误，Node 会在拆卸中途杀死进程——恰好残留下本次要恢复的终端状态。后续 rejection（包括 release 自身的）都会落入已挂起的退出流程。
- release 以 `FAIL_LOUD_RELEASE_TIMEOUT_MS`（2 秒）为上限，且其 rejection 被吞掉。卡住或失败的 disposer 只会延迟致命退出，绝不会取消它。该定时器保持 **referenced**：一旦 `unref()`，Node 就会在事件循环清空后、恰恰在报告这次失败时以 0 退出，因为 `unhandledRejection` 监听器抑制了默认的致命退出。
- 不传 `release` 时行为与此前完全一致，因此 ACP（Agent Client Protocol）、JSON-RPC 和各 demo bin 均无变化。

`dsh` 的 TUI 启动器传入的 release 会释放根上下文，从而执行 TUI 已有的 `shutdown()` 并把终端交还。

启动器在 `boot()` 的 `prepare` 钩子中捕获根上下文，而不是取其返回值。rejection 到达时 `boot()` 尚未结算，因此在 `await` 之后赋值的 `app.current` 恰好在回调需要它的那一刻仍是 `undefined`。`prepare` 在 Loader 安装之后、任何配置树条目挂载之前运行，覆盖了条目可能 rejection 的整个窗口。

## 考虑过的替代方案

**在响亮失败处理函数里直接重置终端**（写 `ESC [ ? 2004 l`、弹出键盘协议、清除 raw 模式）。这会在一个并不拥有终端的包里重复 pi-tui 的拆卸逻辑，并随 pi-tui 启动序列的变化而漂移。它同样无法吸收尚未返回的 Device Attributes 响应——而这正是弄乱下一个提示符的原因，只有在 stdin 仍处于 raw 模式时排空它才能解决。

**在 TUI 中注册 `process.on('exit')` 终端重置。** exit 处理函数是同步的，无法等待 `drainInput()`，残留响应依旧会落到 shell；而且这把拆卸挂到全局钩子上，而非已经存在的释放路径。

**让 TUI 等整棵树结算后再启动。** 这会把刻意并发的 Loader 串行化，并为修复一条失败路径而拖慢每一次正常启动的首次绘制。

**调整配置顺序，让 `llm-pi-ai` 先于 `ui-tui` 挂载。** 顺序并不是 Loader 提供的保证，而且未来任何条目都可能在 TUI 挂载之后失败。

## 后果

启动失败现在会在退出前多付出一次树释放的代价（上限 2 秒），退出码仍为 1。作为交换，配置错误的 `dsh` 会交还一个可用的 shell，而不是需要 `stty sane` 或 `reset` 才能恢复的终端。

这项保证属于**拥有终端的那个 bin**：任何抢占终端状态却不传 `release` 的界面都会重新引入该缺陷。`installFailLoud` 自身无法察觉这一点，因为它看不到已挂载的插件对进程做了什么。

## 测试

`packages/boot/app-boot/tests/app-boot.spec.ts` 覆盖 release 约定：退出提交前会等待该钩子；钩子 rejection 时仍退出 1；永不结算的钩子会在 `FAIL_LOUD_RELEASE_TIMEOUT_MS` 后退出；以及一连串 rejection 只报告第一个，同时 release 仍能跑完。

这些基于假进程的测试无法观测到最关键的两种失败形态——真实事件循环下的进程退出码，以及退出之后的终端状态——因此回归用例放在 `apps/cli/tests/tui-keyless-smoke.e2e.ts`。它在真实 PTY 中以 `fixtures/tui-invalid-provider.cordis.yml`（`providers` 为列表形状，正是用户真实会犯的错误）启动出厂配置树，期望退出码为 1，并断言捕获到的字节流同时包含带标签的启动 rejection（`dsh: plugin tree failed to load:`）与 `ESC[?2004l`。同一用例端到端钉住了启动路径：正是它发现了以 13 静默退出、终端状态未被恢复的 [HMR（热模块替换）初始扫描启动死锁](../../archived/bug-fix/2026-08-03-hmr-initial-scan-boot-deadlock.md)。

`/exit` 路径保留其原有断言，确认正常退出时同样会出现该重置序列。
