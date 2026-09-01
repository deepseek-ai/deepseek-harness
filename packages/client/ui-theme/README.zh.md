---
description: "dsh Web 客户端的主题与正文字号设置：--dsw-* token 样式表、ThemeRuntime 状态、「通用」设置行与插件前引导。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme

[English](README.md) | 中文

## 概述

`dsh-client-ui-theme` 让 Web GUI 用户在设置中选择 `light`、`dark` 或 `system`，并把会话正文字号设为 12 至 17 px。回环客户端把两个值存入 `ui-theme` 设置命名空间，本地提供方默认将其持久化到 `$DSH_HOME/settings.yaml`。插件通过 `prefers-color-scheme` 解析 `system` 并发布不可变的 `ThemeSnapshot`；ui-layout 把每份快照应用到 document。本包还提供 `--dsw-*` token 样式表，并注入同步引导，使所选调色板与字号在外壳加载前生效。第三方主题可通过 `ctx.theme` 注册别名 token 覆盖。

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

用户从设置（「通用」分区）的两行中切换配色方案与正文字号；在回环浏览器上，两个选择都会跨重启持久化。功能插件通过 `ctx.theme` 消费当前快照，并在 CSS 中读取 `--dsw-*` token；它们不自行管理主题状态。

### 外观与字号

插件在「通用」分区注册外观偏好方块与字号步进器。步进器接受 12 至 17 px 的整数，默认值为 14 px。它以相同增量调整会话标题与基础文本，包括用户气泡与 composer 草稿；流内行的标题、摘要与表格跟随比正文低一档的字号，小号文本和代码保持固定字号。每次通过的变更都经 Host settings API 写入。连续快速变更按操作顺序携带命名空间 revision 串行写入，最新写入被拒时重新加载持久值。非 loopback 页面把两个选择都保留在进程内。

### 注册主题

组合可以通过 `ctx.theme` 注册带别名 token 覆盖的第三方主题 id；覆盖层按注册顺序折入活动快照的 token 中。移除其中一个绝不会覆盖最后一个持久化的内置偏好。第三方主题 id 仍是进程内扩展，不会跨越内置 settings schema。

### 插件前调色板

当主机组合包含 HTTP 服务器时，宿主侧会把已注册的 `ui-theme` 设置或 schema 默认值嵌入每份 index 响应。浏览器在加载页面渲染前设置 `color-scheme`、`body[data-ds-dark-theme]` 与 `--dsh-content-font-size`，因此首帧绘制就采用所选调色板与字号。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务拥有主题与字号状态并发布快照。ui-layout 呈现器应用这些快照，token 样式表则拥有颜色与会话文本尺度。

### 样式表

`src/styles/` 下有五张样式表，由 ui-theme 的动态客户端 entry 依次导入：`base.css`、`design-platform.css`、`scrollbar.css`、`gradient-shadow-text.css` 与 `shiki.css`。客户端 bundle 将其编译并注入为插件持有的全局样式，因此卸载与 HMR 会随 ui-theme 一同移除。`scrollbar.css` 是 `--dsw-alias-scrollbar-*` token 的唯一消费方，必须排在声明这些 token 的 `design-platform.css` 之后。

`gradient-shadow-text.css` 从 `--dsh-content-font-size` 派生 `--dsh-content-font-delta`，并以该增量移动 Markdown 标题与基础文本阶梯。它同时派生低一档变量 `--dsh-content-font-size-secondary`（设置 ≤14 时为设置值 −1，>14 时为设置值 −2；默认设置下为 13px）及配套的 `--dsh-content-font-delta-secondary`，供表格变体与比正文低一档的流内行使用。紧凑的小号文本与代码变体保持固定字号。阶梯之外，用户气泡与 composer 草稿直接读取正文档变量对，流内行的标题及摘要读取低一档变量对。

### 滚动条重新绑定

`scrollbar.css` 在 `body` 上把 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 绑定到 l1 基础表面 token；高层级表面（菜单、浮层、对话框）在自己的容器上把它们重新绑定为 l2 token；这组变量的另一个合法目标是 `transparent`（ui-sidebar 在指针不在栏内时就这样重新绑定自己的列）。`--dsh-scrollbar-width` 镜像 WebKit 滚动条的布局宽度，供需要与占布局宽度的滚动条对齐的表面使用。两条渲染路径在构造上互斥：Firefox 走 `@supports not selector(::-webkit-scrollbar)` 内的标准属性，WebKit 系引擎走伪元素，因此 hover token 只经由伪元素这条路径渲染（[滚动条笔记](../../../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md)）。

### 偏好持久化

在 loopback 浏览器上，服务先以 schema 默认值立即提供自身，随后加载 `ui-theme` 命名空间，并把每次通过的主题或字号变更经 Host settings API 写入。收到推送的设置变更时或重连后都会重新拉取该命名空间。非 loopback 页面不会创建该 Host-backed scope。该持久化边界由 [Host 支撑的偏好笔记](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md) 拥有。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖布局呈现器、token 消费方与样式规则。

- [ui-layout](../ui-layout/README.zh.md)——应用解析后主题快照的呈现器。
- [ui-sidebar](../ui-sidebar/README.zh.md)——滚动条重新绑定约定的消费方。
- [ui-conversation](../ui-conversation/README.zh.md)——为 composer 席位消费 `--dsh-scrollbar-width` 的消费方。
- [Web 样式](../../../docs/web-styling.zh.md)——Web 客户端组件的权威样式规则。
- [Host 支撑的偏好](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md)——持久化边界决策。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义主题扩展表面与颜色权威；它们是当前包约束。

- **第三方主题是扩展点，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整。
- **token 样式表是颜色值的唯一权威来源**：设计系统中缺失的值会有意不补入；一律采用最接近的语义 token，设计负责人批准的新增值须在同一变更中以一个静态尺度层级与一个语义别名的形式进入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。settings scope 校验并发布持久 theme section，registry 与自身变更同步发出 `theme/change`；两者关系由 Host、scope 与 service 测试覆盖。
