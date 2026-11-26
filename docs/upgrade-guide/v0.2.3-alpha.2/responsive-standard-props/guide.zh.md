---
kind: upgrade-guide
description: "手工构造 Web Client Slot props 时必须提供响应式钩子和文档钩子。"
---

# 响应式与文档标准 props

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，按媒体查询或设备类别切换的 Web Client 组件自行调用 `window.matchMedia` 或 `isMobileDevice()`。升级后，`GlobalStandardProps` 要求 `useMediaQuery(query)` 与 `useMobile()`，由新的 `@deepseek-ai/dsh-client-ui-responsive` Client 插件提供的 `uiResponsive` 服务发布到每个 Slot 作用域；见[框架提供的 hooks](../../../subsystems/slots.zh.md#framework-provided-hooks)。输入框、右侧栏展开按钮、agent preset 选择芯片、桌面引导流程、模型选择器和会话面板会读取它们，实验性的 Session Inspector 和 Forge 也会读取；这些插件都 inject `uiResponsive`。运行随附 Web bundle 的 profile 无需修改配置。

手工构造完整 Slot props 的 TypeScript 代码必须提供这两个钩子，以及渲染器的 `useDocumentPortal()` 和 `useDocumentViewport()`。使用文档钩子无需注入 `uiResponsive`。省略了 `@deepseek-ai/dsh-client-ui-responsive` 的自定义 Web roster 不再启动这些插件，因为它们的媒体与设备钩子需要 `uiResponsive` 服务。

## 迁移

1. 在手工构造的 props 中展开 `@deepseek-ai/dsh-client-test-runtime` 的固定答案 Hook。不传选项时，它们表示没有任何媒体查询匹配的桌面设备：

   ```tsx
   import { responsiveHooks } from '@deepseek-ai/dsh-client-test-runtime'

   const props: ExpandButtonProps = { ...standard, ...responsiveHooks({ mobile: true }) }
   ```

   传入 `matches: query => query === '(prefers-reduced-motion: reduce)'` 表示要求减少动效。原先用来决定这些组件答案的 `window.matchMedia` 与 `isMobileDevice` 桩，改用这些选项。
2. 通过 `SlotTestRuntime` 渲染的 spec 已经收到 `responsiveHooks()` 和一个 `uiResponsive` 替身服务。挂载生产服务之前，先调用 `await runtime.releaseResponsiveSource()`。
3. 组件读取 `useMediaQuery` 或 `useMobile` 的插件，把 `'uiResponsive'` 加入其 `inject` 列表，使它在两个 props 都存在之后启动，并随它们一起卸载。
4. 在自定义 Web roster 中，只要启用了上述任一插件，就添加名为 `@deepseek-ai/dsh-client-ui-responsive` 的 `dsh.client` 行及其包依赖。
5. 确认迁移结果：客户端测试的类型检查与测试通过，页面能渲染输入框、模型选择器和会话面板。
