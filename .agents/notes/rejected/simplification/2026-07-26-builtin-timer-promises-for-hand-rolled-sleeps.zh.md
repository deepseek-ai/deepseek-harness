# Agent Note: 用 node:timers/promises 替代手写的可取消休眠

Status: rejected — 实现（PR #679）证伪了行为等价前提：vitest 的假时钟不拦截 `node:timers/promises`，这次替换用确定性的快速测试换来约 10 行删除，得不偿失

[English](2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.md) | 中文

## 问题

三个包手写了用 promise 包装的定时器，而 `node:timers/promises` 内置模块早已提供同等能力；其他包（`dsh-llm-mock-server` 的 `pause()`、`dsh-lsp-stdio`、`dsh-acp-snapshot`）已经在使用该内置模块，因此这些手写副本同时也是一处一致性缺口：

- `packages/llm/llm-retry/src/index.ts` 的 `cancellableDelay()`（约 14 行）：`new Promise` + `setTimeout` + 手动添加和移除中止监听器，定时器触发时 resolve 为 `true`、被中止时 resolve 为 `false`，仅在退避等待处消费一次。
- 原 `workflow-worker-thread` host 的 `sleep()`（约 7 行，在 PR #679 中评估）：promise 包装、已 unref 的 `setTimeout`，用作 dispose（资源释放）宽限的时间上界。
- `packages/terminal/terminal-bash/src/session.ts` 的 `delay()`（约 4 行）：朴素的 promise 包装 `setTimeout`，用于轮询与拆卸等待。

## 提案

用 `import { setTimeout } from 'node:timers/promises'` 替换这三处实现：

- llm-retry：`try { await setTimeout(delayMs, undefined, { signal }); /* retry */ } catch { /* abort → fail */ }`。传入 signal 后，该 promise 只会因中止错误而拒绝，已提前中止的 signal 则立即拒绝；行为完全一致，包括中止时清除定时器。按仓库的空 catch 规则，这个空 `catch` 注明其吞下的是 abort 拒绝。
- workflow-worker-thread：`setTimeout(ms, undefined, { ref: false })`，语义完全等价，包括不会让事件循环保持存活。
- terminal-bash：`import { setTimeout as delay } from 'node:timers/promises'`，签名完全相同，调用点无需改动。

没有专属测试固定这些辅助函数本身；各包的行为测试套件继续通过。

## 曾考虑的替代方案

- **`p-timeout`/`p-defer` 一类的包。** 不予采纳：内置模块恰好精确覆盖这些调用点；为一行 await 引入外部包是负收益。
- **维持现状。** 不予采纳，但理由较弱：成本确实很小，但仓库其他地方已经在用这一内置惯用法，而同一内置能力存在两个手写变体，就会招来第三个。

## 验收标准

- 这三个包都不再各自定义 promise 包装的 `setTimeout` 辅助函数，而是都从 `node:timers/promises` 导入。
- `llm-retry`、`workflow-worker-thread` 与 `terminal-bash` 的测试套件原样通过（行为等价）。

## 风险

基本没有风险：不涉及模型可见的输出，没有平台顾虑，也不新增依赖。llm-retry 的改写把一个返回布尔值的辅助函数变成 try/catch 控制流，这是一项局部可读性判断，由实施 PR（Pull Request）裁量。
