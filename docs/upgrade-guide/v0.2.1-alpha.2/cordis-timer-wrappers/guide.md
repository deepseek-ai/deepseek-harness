---
kind: upgrade-guide
description: "Timer wrappers return void in TypeScript and ignore calls after disposal."
---

# Timer wrapper return types and disposal

English | [中文](guide.zh.md)

## Change

The functions returned by `ctx.throttle()` and `ctx.debounce()` now declare a `void` return type. They previously inherited the callback's return type, although they already returned `undefined` at runtime. TypeScript code that uses the wrapper's return value or assigns it to the callback's type may need updating. Host and browser use the same `TimerService` implementation.

Calling `.dispose()` or disposing the owning fiber cancels pending work and makes later wrapper calls inert. A disposed throttle wrapper previously could still execute a leading call; debounce wrappers already ignored calls after disposal.

The `@deepseek-ai/dsh-cordis-client-runner/client` entry no longer exports `ClientTimerService`. The runner installs the shared `TimerService` from `@deepseek-ai/cordis-plugin-timer`.

## Migration

1. Let TypeScript infer the wrapper type, or declare its call signature with a `void` return type while retaining `.dispose()` where needed.
2. Consume callback results inside the callback. Awaiting the wrapper does not wait for an asynchronous callback to finish.
3. Move required work before disposal, or create a new wrapper in an active plugin.
4. Remove imports of `ClientTimerService` from the runner. Consumer plugins declare `inject: ['timer']` and use `ctx.timer`; code that installs the service imports `TimerService` from `@deepseek-ai/cordis-plugin-timer`.
5. Run your extension's type check and verify that calls after disposal neither invoke the callback nor schedule work.
