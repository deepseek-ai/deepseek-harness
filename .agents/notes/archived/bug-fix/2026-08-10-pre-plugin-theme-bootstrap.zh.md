# Agent Note: 插件激活前的主题引导

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-pre-plugin-theme-bootstrap.md) | 中文

## 问题

Web 壳在浏览器侧插件树激活前呈现 `Loading plugins…`。ui-theme 的 token 样式随动态客户端 bundle 到达，因此不依赖框架的加载页使用私有的明暗回退配色。如果不提前写入 `color-scheme` 与 `body[data-ds-dark-theme]`，持久化偏好为深色时，该页面仍会先按浅色回退绘制，再在 ui-theme 的 ThemeRuntime 与 ui-layout 的 ThemePresenter 激活后切为深色。

`dshClient.immediately` 只把 bundle 纳入第一阶段预取，不会让插件在 HTML 解析或壳首次渲染前执行。仅调整客户端插件的加载档位无法关闭这段时间窗口。

## 决策

ui-theme 的主机侧以一条 body 定位的 script 行（`bootThemeInjection`）回应每次 `webserver/index-inject` 收集，`renderIndex` 把它渲染为 `<body>` 起始标签后紧接的一段同步内联脚本。订阅是无条件的——没有 web server 的组合根本不会 emit 该事件，ui-theme 照常激活且不贡献任何行。HTML 解析器执行该脚本时，body 已存在，而壳的模块脚本与不依赖框架的启动页尚未运行。

settings provider 存在时，主机侧会注册 [`ui-theme.preference` settings 分节](2026-08-06-host-backed-web-preferences.zh.md)。它为每份 index 响应把经过 schema 校验的内建偏好嵌入内联脚本；不存在 settings provider 或有效注册时则嵌入默认值 `system`。浏览器通过 `prefers-color-scheme` 解析 `system`，不支持 `matchMedia` 时回退为浅色。脚本只写 ThemePresenter 后续拥有的两项 DOM 状态：`document.documentElement.style.colorScheme` 与 `body[data-ds-dark-theme]`。

引导逻辑只认识内建的 `light`、`dark`、`system` 语义，不注册监听器，也不解析第三方主题或 token 覆盖。浏览器侧插件树激活后，ThemeRuntime 仍是主题状态的权威来源，ThemePresenter 会把完整解析结果重新写入同一组 DOM 状态并负责后续更新与释放。

## 验证

ui-theme 的单元测试覆盖不含任一可选 Host 服务时的激活、脚本位置、Host 设置优先级、系统偏好、缺少 `matchMedia`、不含 body 的输入、实时读取 settings，以及 Host 注册随插件 fiber 一同释放。真实 Web 组合的 Chromium 场景会选择持久化深色偏好并拦住插件 bundle 请求，使加载页保持可观察，再断言 index 响应产生了深色背景、body 属性和根元素 `color-scheme`。该变化不改变可访问性树，因此不产生新的页面 golden。

## 考虑过的替代方案

**把逻辑固定写进 `apps/web/index.html`。** 这样能在相同时机执行，但静态 HTML 无法嵌入当前 Host 设置，还会复制 ui-theme 拥有的偏好解析和 DOM 字段；Host 转换会跟随主题插件的生命周期，并让应用壳无需了解主题领域。

**让 ui-theme 客户端 bundle 同步或更早激活。** `immediately` 只控制预取，插件实例化仍发生在壳开始运行之后；把首次渲染阻塞到 ThemeRuntime 激活会延后可见的加载与报错界面，也会让壳的故障呈现依赖被它监测的插件树。

**只依赖 `prefers-color-scheme` 的 CSS。** 媒体查询无法读取显式持久化选择，因此操作系统为浅色而用户选择深色时仍会闪烁。

**在 `<head>` 中执行并给 html 添加临时类。** body 此时尚不存在，还需要一套与正式调色板属性不同的临时选择器。紧接 `<body>` 是能够直接写正式 DOM 字段的最早解析位置。

## 后果

加载页首帧与持久化内建偏好一致；未组合 settings provider 时则默认采用系统偏好。index 转换会为每份响应读取 Host settings，而内联脚本只包含选定的内建值与 `system` 解析逻辑。内建偏好语义或 ThemePresenter DOM 字段变化时，必须同时更新脚本与 ThemeRuntime。自定义主题仍会在浏览器插件激活后才完整应用；加载期间，页面使用自己的浅色或深色回退配色。
