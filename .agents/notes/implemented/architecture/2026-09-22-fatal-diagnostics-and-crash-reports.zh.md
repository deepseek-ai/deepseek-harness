# Agent Note: 致命诊断与 Desktop 崩溃报告

Status: implemented

[English](2026-09-22-fatal-diagnostics-and-crash-reports.md) | 中文

## Problem

Desktop 应用的两起用户侧故障都是靠致命恢复对话框的截图定位的。该对话框只显示错误的最后八行，并且当时声称完整诊断已写入 Electron 控制台，而打包安装的应用从不暴露那个控制台。

Windows 上，`dsh-subprocess-local` 的 `OutputCollector.spillAll` 在子进程 stdout 的 `'data'` 监听器内打开 spill 文件。带 `'wx'` 的 `openSync` 抛出 `ENOENT`，对该标志而言这意味着每进程私有 spill 目录已不存在（它只创建一次、从不重建；是什么删除了它没有被观测到），由于没有任何进程级 handler，Desktop Host 以 Node 默认的未捕获异常输出退出。`path:` 属性恰好落在可见的八行里；此外关于该故障的信息一无所获。

macOS 上，启动审计把一组 Web 客户端行列为 `import failed (see console for the import error)`，而真正的 import 错误只留在渲染进程 console 中。可见的八个名字与依赖同一个 application batch 的行完全吻合，因此该 batch 脚本的一次加载失败可以解释截图；失败是传输错误、过期 URL 的 404 还是响应截断，无法判定。batch 只请求一次，因此任何瞬态失败都是最终结果。

两起事故共享三个缺口：致命诊断没有持久化、Host 没有 `uncaughtException` 策略、一个可失败步骤被允许拖垮整个功能。

## Decision

四条决定一并交付。

**未捕获异常是致命的并会被报告；失败的操作绝不恢复。** `dsh-app-boot` 的 `installFailLoud` 为 `'uncaughtException'` 注册与 `'unhandledRejection'` 相同的 handler：向 stderr 写一条带标签的 `util.inspect` 诊断，在既有超时内等待界面的 release 钩子，以 1 退出。控制流不会回到失败的操作，事件循环只运行到 release 结束或超时，因为只有抛出点知道哪些状态仍然完整；在更新过程中抛出的 `'data'` 监听器已经丢掉了一块数据并只设置了一半自己的字段，恢复运行会把可见的崩溃变成静默错误的输出。用 `util.inspect` 替代 `err.stack`，因为 `node:fs` 错误的 `code`、`syscall`、`path` 以及 `cause` 链都是堆栈行省略的可枚举属性。rejection 的标签 `fatal load failure` 保持不变，因为 Web profile 的 expected-output e2e 测试匹配它；异常使用 `fatal uncaught exception`。

**spill 文件在每一步都是尽力而为。** `spillPath` 本来就是可选的，最终关闭失败时已经会撤回它。`spillAll` 现在包住打开或追加过程中的每一种文件系统失败：丢弃该 spill，通过所有者的 logger 报告一次（`SpillOptions.onFailure`，由运行时和 SSH helper 接到 `ctx.logger.error`），并让内存尾部继续收集。被删除的目录不会重建：该设计的安全性依赖于由本进程一次性创建的随机名称，重建一个已知名称就放弃了这一点。在 `ENOENT` 时新建随机目录是待办工作。

**Desktop 致命失败在弹窗前写入崩溃报告。** 每个 `reportFatal` 调用方都标明来源（`host`、`web-boot`、`renderer`、`main`）。`DesktopFatalRecovery.report` 最多等待 `writeCrashReport` 一秒，然后弹出对话框并把文件路径单独占一行——与错误是否被截短无关，端口占用变体同样如此。报告包含来源、后端是否已就绪、应用与运行时版本、完整的 inspect 错误（backend 状态携带原始错误对象；Host 启动失败通过 fatal IPC 事件携带 Host 自己的 inspect 错误，因为 Host 的 stderr 与该消息存在竞争，而壳只报告它看到的第一个失败），以及从 `webContents` 的 `'console-message'` 捕获的主窗口最近 error 级 console 输出（64 KiB 尾部）。报告位于 `app.getPath('logs')` 下，平台允许时仅所有者可读，启动时保留最新十份。关闭过程中的致命失败只写报告、不弹窗。按钮与恢复操作不变。

**batch 脚本失败是按行的问题，不是启动失败。** 在 `ClientModuleSystem.arrive` 中，传输失败（脚本 `error` 事件；什么都没执行）在同一 URL 上重试一次，等待该 batch 的所有行共享这次重试。加载成功但没有注册某行的脚本绝不重新执行：batch 按顺序注册各包，`register()` 拒绝重复，重放会在原次运行已注册的第一个包处停止。每个已执行的 batch URL 都会被记住，因此即使首个从该 batch 导入的是它已注册的行、之后另一行发现自己缺失，这一点仍然成立。两种情况下每条仍缺失的行随后加载自己的单资源 combo URL，Host 为每个包都提供该 URL；失败的 batch URL 会被记住，后续行直接走回退，而单资源 URL 跨 import 保持可重试（一次启动内 Loader 对每个条目只 import 一次，因此缺失行只有一次回退尝试）。依赖失败用消费者与依赖的名字包装。模块系统在最外层操作按行记录最后一次 `import()` 或 `prefetch()` 失败，因此 factory 执行错误与到达错误一样被捕获，`assertEntriesActive` 按无 fiber 的条目报告该文本。

## 与既有决定的关系

本 note 部分取代 [Desktop 原生致命恢复](2026-09-15-desktop-native-fatal-recovery.zh.md)：对话框指向的记录现在是崩溃报告文件而非 Electron 控制台，对话框详情多出报告路径一行；该 note 对对话框归属、按钮集合与 profile 恢复的决定仍然有效。`uncaughtException` 的处理把 [fail-loud release](../bug-fix/2026-07-31-fail-loud-releases-the-terminal.zh.md) note 的 release 机制扩展到同步抛出。

## 与 Desktop 日志体系设计的关系

Desktop 本地日志设计（Worker 独占写入的滚动 JSONL 日志、封闭事件词汇、脱敏与限流）是持续日志设计，仍是未来工作。它规定 Host stderr 与渲染进程 console 输出永不持久化、错误只以固定分类进入日志。本决定划出一个例外：致命失败的一次性崩溃报告保留原始错误以及保留的 stderr 与 console 尾部，因为两次现场定位需要的正是这些原始内容，而报告有界（error 段截至 256 KiB、Host 诊断 64 KiB、渲染进程 console 尾部 64 KiB）、本地、仅所有者可读，且只在应用已经弹出致命对话框时写入。对话框标明文件名，用户知道自己会分享什么。任何非崩溃报告的内容仍遵循持续日志的隐私姿态。

## Testing

- `dsh-app-boot`：未捕获异常产生带可枚举属性与 cause 链的带标签诊断，与 rejection 共享退出闩锁和 release 超时，两个 handler 都能卸载。
- `dsh-subprocess-local`：打开时 `ENOENT`（目录被删）、打开时 `ENOTDIR`、文件已存在后追加时 `ENOSPC`，三者都保持尾部逐字节一致、撤回 spill 文件、报告一次且不抛出。
- `dsh-client-modules`：传输失败重试一次并共享重试；持续失败按缺失行回退且不重复请求 batch；零注册或部分注册的 batch 不重新执行；单资源 URL 保持可重试；最终错误列出每次尝试；传输、factory 与依赖失败都被记录，成功和失效会清除记录。
- `dsh-client-web`：提供模块系统时启动审计写出记录的 import 错误。
- Desktop：`crash-report` 单测覆盖渲染、仅所有者可读的写入、写入失败、不触碰其他文件的清理以及 console 尾部；`fatal-recovery` 测试在两种语言下钉住带与不带报告路径的对话框文本、一秒上限以及每次致命失败只写一次；启动夹具断言运行阶段 Host 退出的报告输入，包括捕获的渲染进程 console。

## Consequences

Host 现在对两种失败走同一条退出路径，比 Node 立即退出的默认行为最多晚 release 超时的时间，因此致命对话框可能在失败后最多两秒才出现，且 release 窗口内插件写到 stderr 的内容可能把 fail-loud 那一行挤出对话框的八行摘录（报告文件保留 64 KiB 尾部）。spill 失败对用户不再可见，只剩一个带截断标记且没有路径的结果；插件 logger 那一行是唯一痕迹，Host 侧持续日志设计将来会持久化它。崩溃报告持久化原始 stderr 与 console 尾部，理由如上。batch 加载失败现在对每条缺失行最多花费三次请求，且绝不让已注册的行失败；共享的 batch 记忆意味着页面生命周期内，失败 batch 中某行的后续 import 会直接走其单资源 URL。

## Alternatives considered

**捕获未捕获异常并让 Host 继续运行。** 否决：监听器抛出后的状态除抛出点外无人知晓。在 Windows 案例中，继续运行会丢掉该块数据、向模型宣告一个不存在文件的 spill 路径，并在之后每一块上再次抛出。

**在 `ENOENT` 时重建 spill 目录。** 本次否决：重建已知名称放弃了该设计赖以存在的随机目录属性。失败时新建 `mkdtemp` 需要收集器持有目录提供函数而非字符串，作为待办。

**同步写崩溃报告以保持对话框同步。** 否决：在缓慢或网络挂载的 profile 目录上，一次挂起的写入会让壳冻结且完全没有对话框。带一秒上限的异步写入无论如何都会弹出对话框。

**按持续日志设计的规定，崩溃报告只持久化分类后的错误类别。** 对崩溃报告否决：`path:` 属性和渲染进程的 `bundle script … failed to load` 那一行是两次定位的关键证据，按该规则会被抹成 `UNCLASSIFIED`。

**对每种失败都重试 batch URL。** 否决：重新执行一个已注册部分包的 batch 会在脚本内抛出 `duplicate factory registration`，`load` 事件照常触发，调用方看到的还是最初那个「loaded without registering」，无法分辨是重试造成的。

**保留更多代 Host batch URL，使重组的 graph 不会让进行中的启动收到 404。** 推迟而非交付：没有找到 ready 之后改动 graph 的生产触发者，`lazyBody` 缓存响应 Buffer 使保留有实际内存成本，代数与时限是需要 `Config` 字段的部署可调项。
