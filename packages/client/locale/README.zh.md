---
description: "面向用户与插件作者的 web GUI 本地化说明：zh/en 偏好、浏览器派生回退、类型化命名空间词典与框架翻译席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-locale

[English](README.md) | 中文

## 概述

`dsh-client-locale` 为 web GUI 提供本地化：用户在“设置 → 常规”中从已注册语言中选择，UI 文案会立即切换。本包内置 `zh` 与 `en`，外部 client 插件可以增加语言及其命名空间字典。在 loopback 页面上，该选择以 `locale.preference` 存储在 `$DSH_HOME/settings.yaml` 中；非 loopback 页面即使由 Connection 认证所有 API 方法，也只在进程内保留选择。全新浏览器会先临时使用 `navigator` 请求的第一个已注册语言，直到允许读取的 Host 偏好到达并实时替换。插件作者使用内置字典形式时会获得完整类型检查，并通过框架 `t` 席位翻译；经 slot 渲染的文案会随语言切换即时更新。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只要 web GUI 需要语言切换或翻译文案就使用它：已发布的设置行覆盖用户侧，插件作者则注册自己的词典。挂载无需任何配置——本包随客户端树一起激活。

### 选择语言

打开“设置 → 常规”并选择一种已注册语言。生效中的 locale 会立即应用：UI 文案切换、`<html lang>` 指向外部 id 或内置语言的文档标签，选择写入持久设置分区。没有显式 Host 偏好的浏览器会按完整标签、再按主子标签选择 `navigator` 请求的第一个已注册语言，无法匹配时回退到 English。已存储的外部 locale 会等待其定义注册，不会在不可用时生效。

### 注册词典

用已合并进 `LocaleNamespaceMap` 的命名空间调用 `ctx.locale.register(ns, { zh, en })`；编译器会对照该命名空间的类型化键并集检查每个键，并要求两个内置 locale 齐全。消费方通过 `ctx.locale.bind(ns)` 或框架注入的 `t` 席位翻译。UI 已挂载后再注册的词典无需重新挂载即可生效。

### 注册语言包

外部 client 插件把语言定义和每个已翻译命名空间注册为自身拥有的 effect；定义与字典可以按任意顺序注册：

```js
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
    'my-locale: language',
  )
  ctx.effect(
    () => ctx.locale.register('common', 'ja', {
      cancel: 'キャンセル',
      close: '閉じる',
    }),
    'my-locale: common dictionary',
  )
}
```

外部 id 必须是非空的 ASCII BCP 47 风格标签。它的 fallback 必须已经注册，且整条链必须终止于 `en`；未知目标、重复 id 与循环会在注册时失败。查找时先在请求命名空间内遍历生效语言的 fallback 链，再在 `common` 中遍历该链，最后显示键本身。卸载语言定义会将其从选择器移除，并让生效中的选择回落到可用的浏览器语言或默认语言。

### Host 半侧做什么

Host 通过 settings 服务为 loopback 页面持久化偏好。Client 会刻意拒绝非 loopback 页面使用该 settings scope，因此即使 Connection 认证所有 API 方法，它们的 locale 选择仍只存在于进程内。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 locale 服务的构建方式；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

一个 `LocaleRuntime` 同时拥有偏好与词典注册表，并且自身就是 slot 系统的 `LocaleFace`：`getSnapshot`／`subscribe` 通过 `ctx.slots.installLocale` 支撑框架注入的 `t` 席位。不可变快照携带生效中的 locale、可选择的 locale 列表与单调 revision；词典注册与 locale 切换都会推进 revision，但只有切换会发出 `locale/change` 事件。产品编写的 Client UI 文本必须来自这些带类型的字典，或来自已经本地化的 primitive prop；`verify-client-ui-i18n` 强制执行该源码归属（见[决策](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)）。

### 偏好解析

临时 locale 来自浏览器（`navigator.languages` 先按完整标签、再按主子标签匹配，以 English 作为回退），在允许使用的 Host-backed settings scope 送达其存储偏好之前生效。Host 读取在插件激活后运行，因此 settings scope 不可用或被拒绝都不会阻塞页面，结果会实时替换临时值。已存储的外部 locale 会等待其定义注册。`setLocale` 是唯一写入入口；即使 id 已与生效中的 locale 匹配也会持久化，因为生效中的值可能是临时的，必须能在共享同一 home 的其他浏览器上存活。

### 词典查找

带类型的对象形式要求两个内置 locale 都有完整字典；逐 locale 形式允许语言包独立注册每个命名空间。逐键查找会先在请求命名空间中沿生效语言声明的 fallback 链查找，再在 `common` 中重复该链，最后显示键本身。绑定的翻译函数按命名空间保持稳定身份，因此可以挂在 inject 表面上而不破坏 memoization。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | `LocaleRuntime`、词典注册表、Language 行注册、`locale/change` 事件 |
| [`src/index.ts`](src/index.ts) | node 半侧：注册 `locale` 设置命名空间 |
| [`src/locale-settings.ts`](src/locale-settings.ts) | `locale.preference` 的持久 schema |
| [`src/locales/`](src/locales/) | 已发布的 `zh`／`en` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当 locale 约定不够用时阅读以下页面：它所实现的 slot 面孔、它所依托的设置界面，以及偏好背后的持久化决策。

- [客户端 slot 系统](../ui-slots/README.zh.md)——本包实现的 slot 模型与 `LocaleFace` 席位。
- [Host 支撑偏好决策](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md)——偏好为何持久化在 Host 设置中而非浏览器里。
- [设置组地图](../../settings/README.zh.md)——存储该偏好的设置服务。
- [客户端组地图](../README.zh.md)——本包所属的浏览器半侧。

-----

<a id="model-experience"></a>
## 模型体验

无。locale 服务属于浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本地化在哪些地方不完整，或在注册时被冻结。它们是当前包约束，不是任务积压。

- **注册表持有的文本只读取一次翻译**——在 slot 渲染路径之外于注册时捕获的文案（例如 command 注册表中的 `/model` 命令描述）在重新注册前保持注册时的语言；slot 渲染的文案随切换实时更新。
- **语言包负责语言特有行为**——注册表提供选择、持久化、浏览器匹配、逐 key 回退和 `<html lang>`；它不增加复数规则或双向布局。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。locale catalog 与字典没有可供交叉核对的独立运行时来源；注册释放、偏好解析和 fallback 查找由行为测试覆盖。
