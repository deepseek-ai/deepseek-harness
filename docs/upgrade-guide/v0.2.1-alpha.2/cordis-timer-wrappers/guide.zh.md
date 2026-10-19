---
kind: upgrade-guide
description: "Timer 包装函数的 TypeScript 返回类型为 void，释放后忽略后续调用。"
---

# Timer 包装函数的返回类型与资源释放

[English](guide.md) | 中文

## 变更

`ctx.throttle()` 和 `ctx.debounce()` 返回的函数现在声明 `void` 返回类型。此前这些函数继承回调的返回类型，但运行时已经返回 `undefined`。使用包装函数返回值或将包装函数赋给回调类型的 TypeScript 代码可能需要更新。Host 与浏览器使用同一份 `TimerService` 实现。

调用 `.dispose()` 或释放所属 fiber 会取消待执行的工作，并使后续包装函数调用不再执行。此前已释放的 throttle 包装函数仍可能执行前沿调用；debounce 包装函数在释放后已经会忽略调用。

`@deepseek-ai/dsh-cordis-client-runner/client` 入口不再导出 `ClientTimerService`。runner 安装的是 `@deepseek-ai/cordis-plugin-timer` 中的共享 `TimerService`。

## 迁移

1. 让 TypeScript 推断包装函数的类型，或将其调用签名声明为返回 `void`，并按需保留 `.dispose()`。
2. 在回调内部使用回调结果。对包装函数使用 await 不会等待异步回调完成。
3. 将必须执行的工作移到资源释放之前，或在活动插件中创建新的包装函数。
4. 移除从 runner 导入 `ClientTimerService` 的代码。消费插件声明 `inject: ['timer']` 并使用 `ctx.timer`；负责安装服务的代码从 `@deepseek-ai/cordis-plugin-timer` 导入 `TimerService`。
5. 运行扩展的类型检查，并验证释放后的调用既不会执行回调，也不会安排工作。
