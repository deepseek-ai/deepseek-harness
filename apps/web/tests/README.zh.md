# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试在进程内启动真实的 web 组合，并用真实浏览器通过真实 HTTP 驱动它。Chromium 运行整个 lane；[模型与推理强度选择场景](declared-reasoning.e2e.ts) 还在 WebKit 中运行，以覆盖原生鼠标焦点行为。[会话回放恢复](session-replay-reload.e2e.ts)还在 WebKit 中运行，共用 `fresh-round-trip` 的录制和预期输出，不改写这些文件。该用例覆盖输出中刷新、完成后刷新和重新打开 Session。该 lane 的运行机制——模式、fixture（测试前置数据）、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在 [`scaffold.ts`](scaffold.ts) 和 [浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md) 中。

安装工作区依赖后，在仓库根目录安装浏览器及其系统依赖：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

在 Linux 上，`--with-deps` 会通过系统包管理器安装依赖。持久化 CI VM 必须通过镜像维护提供这些依赖，CI 只安装浏览器程序，遵循[故障切换手册](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.zh.md)的要求。

普通场景以没有已登记 Workspace 或 Session、但持久化标记记录默认 Workspace 已被删除的状态启动，使显式文件夹选择场景自行决定 cwd。`launchWebScaffold({ firstUse: true })` 保留初始化资格，供启动场景使用。

当天消息的 golden 使用共享的 `WEB_FIXTURE_TIME`：预置会话将它传为 `createdAt`，并通过 `pinBrowserClock` 固定浏览器日期；提交实时消息的场景还使用 `pinHostClock`，在清理后恢复。固定后的时钟随真实耗时前进，保留原生定时器，因此跨午夜不会改变场景的日期标签。

## 完成状态观察

依赖状态的用例使用 Workspace、接纳、附件和模型流屏障，区分可见中间状态与已完成操作。模型选择器的持久化断言等待默认设置保存完成，不以菜单关闭作为完成信号。详情关闭等待框架过渡结束；归档验证为 seed Session 设置显式标题，并跨重载跟踪该身份。[CI 测试可靠性工作流](../../../.agents/skills/dsh-ci-test-reliability/SKILL.md#synchronize-on-state)负责这些同步规则。

[空闲提交交接](idle-submission-handoff.e2e.ts)对 Host 帧和浏览器中的消息归位的等待使用 scaffold 的 30 秒 Turn 完成预算。Vitest 负责 scaffold 清理，使 replay 消耗检查错误不会覆盖场景中失败的断言。

插件管理器和 HMR 生命周期场景中的开关为 Host 的 profile 写入与 store 随后的 inventory 读取预留 `PLUGIN_TOGGLE_SETTLE_MS`（10 秒），这两步完成后才会重新发布 `aria-checked`；链路的实测值记录在该常量的 JSDoc 中。

显式滚动使用 `support.ts` 的 `scrollIntoView`：旧元素脱离 DOM 时重新解析 locator，并在同一个浏览器任务中检查连接状态、执行原生滚动。各场景保留滚动后的可见性与几何断言。

问答输入框的缩放断言等待 CSS 滚动时间线更新，使溢出、裁剪遮罩与展开按钮的可见性一致。

[侧栏窗格关闭后的快照](shortcuts-panels.e2e.ts)在捕获前将指针移出控件，并等待悬停提示关闭。键盘焦点保持在窗格上。

[同源窗口终端用例](sidebar-terminal.e2e.ts)等待 UI 触发的 Host 关闭操作完成后，再检查进程终止。它还检查第一个窗口的进程、保存的绑定以及重载后的布局。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取 Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 Cordis `Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处 Host 服务访问都无法编译。

新增场景要在同一次改动里登记到两份工程清单：根 `tsconfig.host.json` 的 include，以及 Client aggregate `apps/web/tsconfig.json` 的 exclude。该工程包含整个 `tests` 目录，漏登记 exclude 的文件会按 Client 代码编译，`pnpm run typecheck` 的 Client compiler 关卡会一直以 Host 服务错误失败，直到它被列入。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它的 TypeScript 工程及其引用的工程拉进 Host 构建图。生成的 Remote 声明在包编译之前就绪，但这并不使 Host 与 Client 的 Cordis `Context` 声明兼容。保留这些测试的 Host face 归属，只使用下文明确的 built-client harness 例外。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的 import 点明源模块。这样漂移会表现为选择器未命中或镜像值陈旧——是响亮的失败，绝不会是静默通过。`scaffold.ts` 按此规则镜像 welcome-notice 的 namespace、确认字段、版本和被断言的中文文案。

built-client harness 是例外。`assembled-boot.ts` import `AppWebEntry`、boot manifest（元数据清单）类型与 `RemoteMock`；`assembled-remote.ts` import Client test runtime 的默认响应与 `RemoteMock`。这些包是显式的工程引用，用于通过测试持有的 carrier 启动真实 shell。chat 场景仍在 `support.ts` 中镜像 `conversationContextKey`，而不 import 其 Client owner。

没有任何机制强制这条规则；靠 review 守住它。
