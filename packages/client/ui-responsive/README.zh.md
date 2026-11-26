---
description: "在 Web Client Slot 组件中通过标准 props useMediaQuery 与 useMobile 读取 CSS 媒体查询结果和移动设备类别。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-responsive

[English](README.md) | 中文

## 概述

任何 Web Client Slot 组件都可以按 CSS 媒体查询，或按页面是否运行在手机或平板上，切换渲染结构或行为，而不必自己读取 `window`。`useMediaQuery(query)` 回答查询当前是否在页面窗口中匹配，结果变化时组件重新渲染。`useMobile()` 在每个页面中只判断一次，用于自动聚焦和软键盘相关的决定。纯样式差异仍写在 CSS `@media` 规则中。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 应用 bundle 挂载此 Client 插件，无需配置字段。它发布两个全局标准 props，因此每个 Slot 组件在任何作用域中都会收到它们。

### 选择 prop 还是 CSS

- `useMediaQuery(query)` 返回 CSS 媒体查询当前是否在页面窗口中匹配，结果变化时组件重新渲染。只有当结果决定渲染结构或行为时才使用它，例如在 `(prefers-reduced-motion: reduce)` 下跳过入场动画。纯样式差异保留在 CSS `@media` 规则中。
- `useMobile()` 返回 [ui-primitives](../ui-primitives/README.zh.md) 的 `isMobileDevice()` 判断：按 user agent 识别的手机和平板，包括桌面模式的 iPad。该结果在页面生命周期内固定不变。它只用于自动聚焦、软键盘等行为；布局按宽度媒体查询选择断点，这是[响应式规则](../../../.agents/skills/dsh-responsive-ui/SKILL.md#9-input-capabilities-and-mobile-text-fields)的要求。

### 组合与测试

组件读取这些 props 的插件（其中包括输入框和会话面板）都 inject 本包提供的 `uiResponsive` 服务，因此只在两个 props 发布之后启动，并随它们一起卸载；组件读取其中任一 prop 的插件也应这样做。该服务没有公开成员。只要自定义 Web roster 保留了这样的插件，就必须保留本包；缺少本包时，这些插件会一直等待 `uiResponsive`，不会启动。手工构造 props 的组件测试展开[客户端测试运行时](../../test-support/client-runtime/README.zh.md)提供的 `responsiveHooks(options?)`，该运行时的 `SlotTestRuntime` 也会提供带同样默认值的 `uiResponsive` 替身。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`uiResponsive` 服务在构造时通过 `ctx.slots.provideRoot` 提交一项根标准数据源。其中 keyed 的 `mediaQuery` 解析函数在服务生命周期内为每个查询字符串保留一个 observable source，因此读取同一查询的组件共用 `window.matchMedia` 返回的同一个 `MediaQueryList`。每个订阅者各自添加 `change` 监听，并在卸载时移除。Renderer 把这个解析函数绑定为 `useMediaQuery`；本包不含 React 代码。`useMobile` 是普通函数 prop，返回构造时读取的 `isMobileDevice()` 结果。释放服务 fiber 会同时撤回这两个 props 和服务本身，inject 它的插件随之卸载。

| 文件 | 负责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | `uiResponsive` 服务、按查询划分的 source 与 `GlobalStandardProps` 声明 |
| [`src/index.ts`](src/index.ts) | 空的 Host Loader 入口 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Web Client Slots](../../../docs/subsystems/slots.zh.md#framework-provided-hooks) — 每个 Slot 组件收到的标准 props。
- [ui-primitives](../ui-primitives/README.zh.md) — `isMobileDevice()` 设备分类。
- [客户端测试运行时](../../test-support/client-runtime/README.zh.md) — 用于手工构造 props 的 `responsiveHooks()`。

-----

<a id="model-experience"></a>
## 模型体验

无，因为媒体查询和设备判断只影响浏览器呈现，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些结果不会进入模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 每个不同的查询字符串在插件生命周期内保留其 `MediaQueryList`。应传入固定的查询字符串，不要用变化的值拼接查询。
- `useMobile` 只对 user agent 分类，不描述输入能力；输入能力由 `(pointer: coarse)` 与 `(hover: none)` 媒体查询描述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
