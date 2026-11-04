---
kind: upgrade-guide
description: "保留状态的 Node PTC 在超时或取消时协作式停止，确认失败时终止进程兜底。"
---

# 保留状态的 PTC 超时恢复

[English](guide.md) | 中文

## 变更

`persistent-in-memory` 模式及启用 `scriptPersistence: true` 的 `vm-script` 在超时或取消时请求协作式停止。此前这两种情况总会清空环境；现在取消的工具调用正常抛错，允许 `catch` 和 `finally` 运行。停止确认等待本次执行结束，并保留变量及此前修改。宿主最多等待 `stopGraceMs`（默认 `3000`）取得确认，未收到确认或确认失败时终止受管进程范围。因此阻塞的死循环仍会丢失状态。临时执行仍终止进程。

运行时在收到确认或兜底清理完成后返回，保留原来的 `timeout` 或 `abort` 类型，并在诊断中说明变量是否保留。确认终止后，下一次调用可创建空环境。清理失败返回 `worker-exit`，并阻止复用，直到宿主释放成功。定时器、任意用户 Promise、I/O 回调、Worker 和子进程不承诺按执行取消；收到确认不表示所有 Node 活动均已停止。

## 迁移

1. 检查报告的状态结果，不再假定超时或取消会清空变量。复用保留的绑定；兜底终止后重新创建。此前的效果不会回滚。
2. 清理失败或保留资源不可信时，使用宿主的 `PtcExecutor.reset(agent)` 或运行时 `release(owner)`。模型不会获得重置工具。等待重置完成后再执行代码。
3. 按需在 `@deepseek-ai/dsh-ptc-runtime-node` 配置中设置 `stopGraceMs`。它限制确认等待时间，与现有进程清理的 `graceMs` 独立。验证异步等待会保留此前变量，阻塞的死循环会清空变量。参阅[运行时参考](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md)。
4. 如果 `launch.bootstrapPath` 指向单独安装的 Node bootstrap，随宿主一起升级它。派发前的就绪握手会检查协议版本；旧 bootstrap 报告 `bootstrap protocol mismatch`，不会执行代码。
