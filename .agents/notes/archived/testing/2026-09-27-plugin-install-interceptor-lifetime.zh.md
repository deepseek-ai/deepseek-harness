# Agent Note: 让插件安装拦截器持续到页面关闭

Status: implemented
Archived: 2026-09-30

[English](2026-09-27-plugin-install-interceptor-lifetime.md) | 中文

## Problem

[插件安装场景](../../../../apps/web/tests/plugin-install-cancel.e2e.ts) 在取消安装后，可能留下一次未结束的目录读取。场景在安装阶段之间移除 Playwright 路由时，Host 发出的失效通知仍会触发后台读取。停滞的读取使已安装的包无法进入列表，因此启用操作虽然关闭了对话框，却始终不显示高亮卡片。

## Decision

场景在导航前注册 `installBundle` 和 `cancelInstall` 拦截器，并保留到浏览器关闭。每个拦截器调用一个带类型的处理函数，场景切换阶段时替换该函数。请求交付和取消屏障保持原有顺序，`activeReplySettled` 在下一次安装开始前等待丢失响应的处理函数结束。普通请求仍然到达真实 Host。

[该场景](../../../../apps/web/tests/plugin-install-cancel.e2e.ts)还会单独等待高亮卡片的状态变为 `running`。持续启用拦截使目录读取能够完成；轮询其结果仍负责确立预期输出记录的状态。

## Alternatives considered

**用 `unrouteAll({ behavior: 'wait' })` 移除路由。** 等待匹配的处理函数结束并不意味着其他浏览器请求已结束。捕获的 Chromium 协议记录显示，`Fetch.disable` 后紧接着发出 `pluginManager/listPlugins` 请求，直到清理前都没有响应或失败事件。直接调用 Host 的目录和插件方法仍能得到答复。

**推进浏览器时钟或延长 locator 超时。** 推进已暂停的时钟不能释放停滞的请求。包始终未进入目录，不是 2.4 秒的高亮到期计时器造成的。

**增加通用路由切换辅助函数。** 一个场景中的两个端点处理函数不需要另一层 fixture（测试前置数据）API。局部委托函数保留了现有取消和丢失响应场景，也不改变浏览器的拦截配置。

## Verification

未修改的场景单独运行通过，四个并发独立进程中有一个在同一高亮卡片 locator 处失败。插桩失败将未获响应的目录请求定位到第二次 `unrouteAll` 的执行区间内；推进页面时钟后请求仍未获响应，而直接读取 Host 可以完成。协议记录独立于 DOM 断言确认了拦截状态的切换。

`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/plugin-install-cancel.e2e.ts` 在四个并发独立进程中全部通过，每个进程均为 1/1。一次协议记录观察到一次 `Fetch.enable`、零次 `Fetch.disable`，且全部 33 次目录请求均收到响应。现有预期输出覆盖取消先于请求交付、取消运行中的子进程、恢复 manifest（元数据清单）与 lockfile、重试、已启用卡片状态、两种主题与动画偏好、高亮到期，以及丢失结果恢复。

## Consequences

浏览器在整个生命周期内保留两个精确匹配的拦截器。场景控制其行为时不会中断并发目录读取，浏览器关闭负责清理它们。产品代码、预期输出、测试超时和 CI worker 数保持不变。

[sidebar-terminal](../../../../apps/web/tests/sidebar-terminal.e2e.ts)、[queue-image](../../../../apps/web/tests/queue-image.e2e.ts)、[subagent-conversation](../../../../apps/web/tests/subagent-conversation.e2e.ts) 和 [subagent-interrupt-ui](../../../../apps/web/tests/subagent-interrupt-ui.e2e.ts) 中也仍有页面存续期间的 `unrouteAll` 调用。这些位置可分别调查请求重叠；本场景的复现并不能确定那些测试失败的原因。
