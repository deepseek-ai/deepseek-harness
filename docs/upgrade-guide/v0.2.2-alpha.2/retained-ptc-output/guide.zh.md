---
kind: upgrade-guide
description: "保留状态的 Node PTC 环境不再报告继承的原生输出。"
---

# 保留状态的 PTC 输出与未完成工具

[English](guide.md) | 中文

## 变更

保留状态的 Node PTC 环境不再将继承的原始 stdout/stderr 写入程序日志，因为这些字节无法归属到单次执行。此前，程序执行期间收到的字节可能来自较早启动的子进程。被捕获的 `console` 和 `process.stdout.write` / `process.stderr.write` 仍受支持；原始 stderr 仍用于进程退出诊断。

保留状态的 Node 环境在执行结束或取消时，未完成的工具调用都会抛错。临时执行在完成后让未完成的 Promise 保持挂起，直到进程退出。用户的 `catch` 和 `finally` 可以运行，但已结束的执行不能发起新工具调用或输出捕获日志。任意用户 Promise 和回调不承诺取消。

## 迁移

1. 在保留状态的 `run_code` 程序中，显式收集子进程输出并通过 `console.log` 打印，或使用 SDK 的 `tools.bash` 结果，替代 `stdio: "inherit"`。
2. 返回前等待所有工具调用。等待必要的清理完成；强制终止进程无法运行 JavaScript 清理处理器。
3. 将预安装的 `launch.bootstrapPath` 与宿主一同升级；控制消息现在携带执行标识，就绪握手会在派发程序前拒绝版本不匹配的 bootstrap。
4. 连续运行程序两次，确认每次结果仅包含本次输出与等待完成的工具结果。参阅 [Node 运行时限制](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#known-limitations-and-deferred-work)。
