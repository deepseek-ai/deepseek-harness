# Agent Note: HMR 初始扫描使失败的启动死锁为静默的 exit 13

Status: implemented
Archived: 2026-09-04

[English](2026-08-03-hmr-initial-scan-boot-deadlock.md) | 中文

## 问题

当 `dsh` 启动时配置树校验失败，进程以 13 退出（未结算的顶层 await），不输出任何诊断，并把 TUI 的终端状态残留在 shell 上——这正是 [fail-loud release](2026-07-31-fail-loud-releases-the-terminal.zh.md) 修复过的症状，在[事务化配置重载](2026-07-20-config-hot-reload-resilience.zh.md)之后经由另一条机制重新出现。

两个缺陷叠加：

1. **并发的 Include apply 破坏事务化的 group update。** HMR 主 watcher 的 chokidar 初始扫描会把每个已存在的文件重新宣告为 `add`。其中配置文件的 `add` 在 Include 的首次 apply 尚未结束时触发了 `Include.refresh()`（内容去重键 `this.content` 只在 apply 完成后才提交）。同一 group 上两个并发的 `EntryGroup.update` 会在相同条目上交错执行 create 与回滚，导致 Include fiber 永远无法结算：`loader.create` 挂起，`boot()` 既不 resolve 也不 reject，事件循环排空后 Node 以 13 退出。
2. **仅序列化 apply 会让失败回滚死锁。** 将 Include 的变更排入队列后，首次 apply 失败时的回滚会释放每个已挂载条目——包括 `hmr`，而它的拆卸会等待自身的 refresh 任务排空。扫描触发的 refresh 任务正排在 Include 队列中、位于正在回滚的那次 apply 之后：回滚等 HMR，HMR 等 refresh，refresh 等 apply。

## 决定

两处修复都落在 vendored 包中（记录于 `vendor/README.md`）：

- `include/src/index.ts` 将每次子树变更——首次 apply、refresh、`internal/update` 补丁重应用——汇入每个 Include 一条的 promise 队列。group 的事务化 `update` 不可重入，因此序列化是正确性要求，而不是吞吐取舍。`refresh()` 也在队列内读取文件，使其内容变更判断与前一任务提交后的状态比较。
- `hmr/src/index.ts` 给主 watcher 传入 `ignoreInitial: true`。初始扫描只会重新宣告启动刚刚消费过的文件；抑制它同时消除了启动期 refresh 和对已加载模块的多余 `add` 事件。`registerConfig()` 保留自己 `ignoreInitial: false` 的 watcher，因为注册时已存在的个人配置必须恰好应用一次。

两者齐备后，失败的启动走上预期路径：唯一一次 apply 失败，回滚并 dispose（资源释放）整棵树（执行 TUI 自身的 shutdown、恢复终端），`loader.create` reject，`boot()` 重新抛出带标签的诊断并以 1 退出。

## 曾考虑的替代方案

**只加 `ignoreInitial: true`。** 消除了触发条件，但保留了破坏本身：任何真正并发的 refresh（配置编辑与缓慢的 apply 竞争）仍会交错两次 group update 并使 fiber 悬置。

**只做序列化。** 把破坏转化为上述回滚死锁；进程仍然静默地以 13 退出。

**在 HMR 拆卸时取消排队中的 refresh。** 需要在 `refreshConfig` 的任务循环和 Include 队列中铺设取消机制，而 `ignoreInitial` 已把该场景从每次启动中移除；在真实触发条件出现之前不值得引入这套机构。

## 后果

落在 watcher 启动扫描窗口内的配置文件编辑，现在由下一个 `change` 事件而非扫描本身拾取；稳态的重载行为不变。

仍留有一个潜在缺口：在一次*失败的*首次 apply 期间进行的配置编辑，仍可能排入一个被回滚的 HMR 拆卸所等待的 refresh——同样的死锁形态，但触发窗口缩小到一次失败启动的人力尺度。若它真的发生，修复方向是在 HMR 拆卸时取消 refresh 任务。

## 测试

`apps/cli/tests/tui-keyless-smoke.e2e.ts` 中 `dsh` 无效 provider 的 PTY 用例钉住了端到端约定：以 1 退出、带标签的 `dsh: plugin tree failed to load:` 诊断指明 `$.providers`、以及证明整棵树已被释放的 bracketed-paste 复位序列。此修复之前，同一用例观察到的是无诊断的 exit 13。重载行为仍由 `packages/boot/app-boot/tests/config-reload.spec.ts` 与 `packages/boot/app-boot/tests/hmr-config.spec.ts` 覆盖。
