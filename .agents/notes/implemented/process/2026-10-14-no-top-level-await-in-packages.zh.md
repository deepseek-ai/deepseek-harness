# Agent Note: 包源码禁止顶层 await

Status: implemented

[English](2026-10-14-no-top-level-await-in-packages.md) | 中文

## 问题

[speech-to-text-sensevoice](../../../../packages/experimental/speech-to-text-sensevoice/README.zh.md) 的子进程入口 `src/worker.ts` 曾在模块顶层 `await startRecognitionServer(...)`。顶层 await 让模块求值变成异步：导入方的求值被它挂住，入口的失败也变成模块加载失败，而不是入口自己显式处理的错误。这个文件同时是包的 `./worker` 导出，浏览器 Preview 的模块加载器按 CommonJS 包装模块体，遇到顶层 await 会拒绝打包，voice-input-bundle 因此无法进入镜像。仓库里当时没有任何门禁阻止这种写法；全仓扫描时，除 bin 外还有另外两处：ssh 的 `src/helper-entry.ts`（`./helper` 导出的目标）和 inspector 的 `src/worker/entry.ts`（worker_threads 入口）。

## 决策

- 入口模块用显式 `async function main()`：
  - sensevoice：就绪前失败时只把错误消息写到 stderr，消息写完后以退出码 1 退出（在写入回调里调用 `process.exit(1)`，否则已加载的原生识别器会让进程一直存活）；stdout 只有一行 `{"port":N}`，Host 把它解析为就绪信号。
  - ssh helper：`main()` 承载 helper 的 try/catch/finally 和信号处理；每个失败都以 `dsh-ssh-sandbox:` 前缀写到 stderr，退出码为 127。
  - inspector worker：同步启动部分留在模块顶层，异步部分在 `main()` 里运行，失败时先发 failure 帧再 stop。
- 门禁 [verify-no-top-level-await](../../../../scripts/verify-no-top-level-await.ts)：
  - **范围**：`packages/*/*/src/**` 下的 `.ts` 和 `.tsx`。
  - **判定**：基于 TypeScript AST。最近的函数体是模块本身的 `await` 表达式、`for await`、`await using` 都算违规，包括顶层 if、块、try、循环、switch、条件表达式、export 初始化和计算成员名里的。函数、方法、构造器、访问器、参数默认值、class static block 里的不算。
  - **排除**：只排除 bin，依据只取声明和语法：源文件以 `#!` 开头，或者是 package.json `bin` 指向的 `lib/<path>.js` 对应的 `src/<path>.ts|.tsx`。bin 由进程直接执行，不会被其他模块导入。当前排除 webworker-packer 和 llm-mock-server 的两个 `src/bin.ts`，清单由 spec 锁定。
  - **语料防护**：语料为空、没有 `.tsx`、或某个含 TS 的 `src/` 目录完全没进语料时，门禁报错。
  - **注册**：`run-gates` 的共享卫生门禁，跑在 static lane 和 hygiene 聚合里。规则正文写在 [package-surface 防御模式](../../../../docs/defensive-patterns/package-surface.zh.md)。

## 考虑过的替代方案

**只靠 webworker packer 的拒绝来把关。** packer 只检查进入镜像的模块，镜像外的包仍可能引入顶层 await。

**用 lint 规则实现。** oxlint 没有现成规则能精确表达“模块顶层”。语法级脚本门禁更可控，也能用测试锁定每一种纳入和排除的形式。

**连 bin 一起禁止。** bin 由进程直接执行，不被导入，顶层 await 不影响任何模块的加载。

## 后果

每个可被导入的包源码都同步求值，包括从不进入 Preview 镜像的包；每个入口自己处理启动失败；voice-input-bundle 能进入 Preview 镜像。

这一取舍的代价：

- 第三方包和 `apps/` 不在范围内；页面引导脚本 `apps/web/src/preview.ts` 使用顶层 await。
- sensevoice 启动失败的诊断只有错误消息，不带堆栈。

## 测试

- [verify-no-top-level-await.spec.ts](../../../../scripts/verify-no-top-level-await.spec.ts) 锁定每一种纳入和排除的形式、语料防护和当前的排除清单；[run-gates.spec.ts](../../../../scripts/run-gates.spec.ts) 锁定门禁的注册。若上述三个入口的异步启动放在模块顶层，门禁报出 4 处（sensevoice 1 处、ssh 1 处、inspector 2 处）并失败。
- [worker-entry.spec.ts](../../../../packages/experimental/speech-to-text-sensevoice/tests/worker-entry.spec.ts) 启动 sensevoice 入口，锁定就绪前失败时退出码为 1、stdout 为空、stderr 给出原因且不带堆栈。
- [helper-boundaries.spec.ts](../../../../packages/ssh/ssh/tests/helper-boundaries.spec.ts) 启动 ssh helper 入口，[integration.host.spec.ts](../../../../packages/experimental/inspector/tests/integration.host.spec.ts) 经 `startInspector` 启动 inspector Worker；没有 spec 触发 inspector worker 入口的启动失败帧。
