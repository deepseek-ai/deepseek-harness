# Agent Note: Web 样式体系——token 框架与工程约束

Status: implemented
Archived: 2026-09-30

> token 体系更新（2026-07-22）：本文框架裁决（CSS Modules + clsx、无组件库、无 tailwind、颜色只用 token）仍然生效，但两层 `--bg-*`/`--text-*` token 表及其宿主 `web-ui/src/style/global.css` 已被 `packages/client/ui-theme/src/styles/` 的 `--dsw-*` static+alias 双层表取代（暗色=`body[data-ds-dark-theme]` 覆写）——样式表本身即 token 权威。

[English](2026-07-19-web-styling-system.md) | 中文

> 分工：本 RFC 定框架与约束（少变）；[docs/web-styling.md](../../../../docs/web-styling.zh.md) 是活规范（token 权威值、编码规范打勾清单、偏离记录，随实现演进）。改 token/加规则去那边；动框架本身才回这里（推翻须新 RFC）。

## Problem

GUI 无设计师供给，样式由 agent 编写并 review；没有一套机器可检查的 token 体系与编码规范，颜色/圆角/动效会在组件间字面量漂移，暗色主题会长成组件内散落的条件分支。

## Decision（框架五条）

| # | 决策 | 内容 |
|---|---|---|
| 1 | **视觉基线 = Chat 对齐** | 取值全部来自对 Chat 前端的调研（品牌蓝 `--accent: #3964fe`、灰阶、气泡/侧边栏几何、阴影分级……）；允许偏离但须在 web-styling.md 偏离表记录 |
| 2 | **token 两层不三层** | 基线仓是 static→alias→specific 三层；我们体量下压成「语义层直接持实值（注释标 base 色板出处）+ 极少数组件专属槽位（`--bg-sidebar`/`--bubble-bg`）」两层，全部住 `web-ui/src/style/global.css` |
| 3 | **字号/间距不 token 化** | 基线仓同款决策：字号在组件里写 px 且**成对写行高**（16/24、14/22、12/18），间距用 4 的倍数；token 化只覆盖颜色/圆角/动效/字体栈/阴影 |
| 4 | **边框与交互态用透明度制** | 边框 `rgba(0,0,0,.04/.1)`、hover/active `rgba(38,49,72,.06/.1)`——叠加在任意层级的背景色上都成立，不新造实色灰 |
| 5 | **暗色只在 token 表做** | `:root` 亮色实值 + `[data-theme='dark']` 覆盖同名变量；**组件 CSS 零主题选择器**；确需按主题换非 token 值时用「CSS 变量桥」（组件定义局部变量、主题块只覆写变量） |

## 工程约束

- **CSS Modules + clsx，无组件库、无 tailwind**：每组件同目录同名 `.module.css`；类名 camelCase、状态类单形容词由 clsx 挂载；组件透传 `className`。
- **禁 `composes`**；`:global` 仅穿透第三方/跨包类名，不定义新全局类；全局工具类只住 global.css 且个位数（现状 `.scrollable`）。
- **PostCSS 插件现状为零**（vite 无 postcss 配置，平铺 CSS 即够用；引入 nested/custom-media 前需先记入 web-styling.md）；CSS Modules 类型声明用 `css-modules.d.ts` 通配 declare（组件数超 20 再评估 typed-css-modules 逐文件生成）。
- **动态样式走 CSS 变量桥**：JS 只写变量（`style={{'--x': v}}`），规则留在 CSS；禁止 TSX 内拼样式对象做主题/状态分支。
- 过渡一律 `var(--dur*) var(--ease)` 且只过渡 opacity/transform/背景色/阴影；滚动容器统一 `.scrollable`（组件内禁写 `::-webkit-scrollbar`）。

## 给 agent 的执行形态

规范以 **review 对照打勾清单**形态维护（web-styling.md §3，12 条）：每条是可判定的「见 X 即打回」，不是风格建议——写样式与 review 样式共用同一张表。

常见事项的入口（操作清单）：

- **写新组件样式**：同目录同名 `.module.css`，对照 web-styling.md §3 逐条自查；颜色/圆角/动效只引 §1 token。
- **加一个 token**：先进 web-styling.md §1 表补一行（亮色值+暗色列+base 色板出处注释）→ global.css `:root` 与 `[data-theme='dark']` 两块同步 → 再在组件里引用。
- **偏离视觉基线常数**（web-styling.md §2 的几何/阴影值）：先在 §5 偏离表记一行（日期/项/理由）再落码。
- **需要按主题变化的非 token 值**（渐变端点等）：组件定义局部 CSS 变量、主题块只覆写变量（变量桥），组件 CSS 保持零 `[data-theme]` 选择器。

## 与 web-styling.md 的分工

| 内容 | 归属 |
|---|---|
| 框架五条、工程约束、为何两层/为何不 token 化字号 | 本 RFC（修改框架须由新 RFC 取代本文） |
| token 逐项权威值（含暗色）、视觉基线常数（侧边栏/气泡/会话行/输入卡片几何）、RPC 四象限方向符视觉词汇、编码规范 12 条、偏离记录 | web-styling.md（活文档，随实现演进） |
| 取值证据（deepseekchat file:line） | 调研归档已完成使命，git 历史留档 |

## Consequences

样式收敛到机器可检查：颜色/圆角/动效/阴影只引 web-styling.md §1 token，暗色是单一属性选择器覆盖表，review 与自查共用同一张 12 条清单。接受的代价：字号/间距靠成对行高与 4 倍数纪律而非 token；动框架本身须由新 RFC 取代本文。

## Alternatives considered

| 放弃项 | 一句话理由 |
|---|---|
| 字号/间距 token 化 | 基线仓实证不 token 化也能收敛（成对写行高纪律替代）；token 表膨胀降低颜色 token 的权威性 |
| 暗色用 `prefers-color-scheme` 或组件内分支 | 属性选择器整表覆盖让组件零感知；系统偏好可后续在 toggle 层适配，不动 token 机制 |
