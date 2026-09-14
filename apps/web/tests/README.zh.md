# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试在进程内启动真实的 web 组合，并用真实 Chromium 通过真实 HTTP 驱动它。该 lane 的运行机制——模式、fixture（测试前置数据）、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在 [`scaffold.ts`](scaffold.ts) 和 [浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md) 中。

## 完成状态观察

依赖状态的用例使用 Workspace、接纳、附件和模型流屏障，区分可见中间状态与已完成操作。详情关闭等待框架过渡结束；归档验证为 seed Session 设置显式标题，并跨重载跟踪该身份。参见 [CI fixture 同步决策](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.zh.md)。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取 Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 Cordis `Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处 Host 服务访问都无法编译。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的 Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译，于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的 import 点明源模块。这样漂移会表现为选择器未命中或镜像值陈旧——是响亮的失败，绝不会是静默通过。`scaffold.ts` 按此规则镜像 welcome-notice 的 namespace、确认字段、版本和被断言的中文文案。

built-client harness 是例外。`assembled-boot.ts` import `AppWebEntry`、boot manifest（元数据清单）类型与 `RemoteMock`；`assembled-remote.ts` import Client test runtime 的默认响应与 `RemoteMock`。这些包是显式的工程引用，用于通过测试持有的 carrier 启动真实 shell。chat 场景仍在 `support.ts` 中镜像 `conversationContextKey`，而不 import 其 Client owner。

没有任何机制强制这条规则；靠 review 守住它。
