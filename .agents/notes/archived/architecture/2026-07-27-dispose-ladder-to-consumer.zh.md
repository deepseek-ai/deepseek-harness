# Agent Note: dispose 阶梯归其消费方所有，而非 subprocess seam

Status: implemented
Archived: 2026-09-04

[English](2026-07-27-dispose-ladder-to-consumer.md) | 中文

## 问题

`SubprocessHandle.dispose(graces)` 与 `SubprocessDisposeGraces` 把一整套拆卸*策略*——等待 stdin EOF、再 SIGTERM、再 SIGKILL，每一层由调用方提供的时间窗约束——放在了一个其余动词均为单一机制的 seam 上。它始终只有一个消费方（ACP（Agent Client Protocol）subagent 后端）；bash 走 `terminate()` 与服务拆卸，LSP 主机运行自己的协议优先关闭流程。然而每个未来后端都必须实现该阶梯才能满足接口，实现包也仅为阶梯的层级时限背上了 `dsh-timeout` 依赖。

## 决策

阶梯移入其唯一消费方。`dsh-subagent-acp` 拥有 `disposeAcpChild(child, eofGraceMs)`，完全构建在 seam 的公开动词之上：关闭 `stdin`，以 `eofGraceMs` 约束一次 `waitForExit`，随后调用 `terminate()`（其 SIGTERM→spec 宽限期→SIGKILL 升级已拥有信号定时器），再无界等待 `waitForExit()`，由子进程责任方证明整棵进程树已经退出。seam 保留 `kill`／`terminate`／`waitForExit`——机制而非策略——而 `waitForExit(signal?)` 恰是消费方阶梯在协作层确认进程树真正退出所需的完全停稳探针，无需从终止宽限期再派生一个定时器。seam 的句柄少了一个方法和一个导出接口。

## 曾考虑的替代方案

**把阶梯作为便利方法留在句柄上。**否决：一个每个 Service Provider 都必须实现的 Service Definition 方法不是便利，而是约定的一部分——而这一个把某一消费方的协作模式（stdin EOF 打头）当作进程词汇来编码。seam 自己的 README 早已不得不加注「依赖其他信号才能完全停稳的子进程需要自己的第一阶」，这本身就是承认该阶梯是策略。

**把阶梯移到共享辅助包。**否决：只有一个消费方。当第二个具有相同 stdin EOF 协作模式的进程外后端出现时，可以再把 `disposeAcpChild` 提升为共享代码；现在抽取只会重造 `dsh-subagent-subprocess`——本次变更删掉的那个单一用途库。

## 后果

买到的：Service Definition 少了一个方法和一个类型；Service Provider 只欠四个动词，不欠拆卸策略；协作式 EOF 时间窗与调节它的 ACP 配置字段住在一起，而终止时间窗与最终的整树退出等待仅由子进程责任方拥有。代价：未来想要 EOF 打头拆卸的后端需针对这些动词写约 20 行（或直接搬 ACP 的辅助函数）；阶梯的层级测试位于 ACP 套件，Service Definition 套件转而钉住阶梯所组合的动词（升级前有界 `waitForExit` 返回假，升级后无界等待整棵进程树退出），而非组合后的策略。
