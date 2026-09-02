# Agent Note: Web superellipse corner smoothing

Status: implemented

[English](2026-09-01-web-superellipse-corner-smoothing.md) | 中文

## Problem

Web 客户端里每个圆角表面——卡片、输入框、按钮、浮层——都以普通圆弧绘制圆角，观感明显硬于当前桌面聊天 UI 普遍采用的平滑（类 squircle）圆角。这种平滑感来自在 `@supports` 守卫内应用 CSS `corner-shape: superellipse(1.5)`，而非更大的半径或遮罩技巧；工具类体系的实现把它挂到除正圆之外的所有圆角工具类上。本客户端没有工具类：`border-radius` 以 px 字面量散布在各客户端包的 CSS Modules 中，没有可以统一挂载该属性的类列表；而正圆形状（`border-radius: 50%` 的圆、999px 胶囊）必须保持圆弧——超级椭圆会把圆变形为 squircle，用 border 绘制的加载圈旋转时会明显晃动，胶囊两端也会变方。

## Decision

`packages/client/ui-theme/src/styles/corner-shape.css` 是由 ui-theme 客户端 entry 挂载的全局样式表（位于 `base.css` 之后）。它在 `@supports (corner-shape: superellipse(1.5))` 内于 `:root` 定义 `--dsw-corner-shape: superellipse(1.5)`，并通过 `*, *::before, *::after` 应用 `corner-shape: var(--dsw-corner-shape)`——`corner-shape` 不继承，通配选择器正是在没有工具类系统的前提下触达每个圆角表面的机制。两条声明都在守卫内，因此不支持 `corner-shape` 的引擎保持普通圆弧。`superellipse(1.5)` 介于 `round`（`superellipse(1)`）与 `squircle`（`superellipse(2)`）之间，与当前桌面聊天 UI 的平滑度一致。

正圆形状在其声明处退出：每个取值为 `50%`、`100%` 或胶囊半径（≥ 99px）的 `border-radius`，都在所属组件样式表的同一规则内配对 `corner-shape: round`。该配对由 `packages/client/ui-theme/tests/corner-shape-styles.client.spec.ts` 强制，它扫描 `packages/` 下的全部样式表（共享扫描辅助函数位于 `tests/stylesheet-scan.ts`，自 scrollbar spec 抽出）；同一 spec 也钉住 `corner-shape.css` 的守卫与通配应用。组件局部半径变量（`--dsl-*-radius`）取值都远低于胶囊阈值，因此词法扫描覆盖当前用法。

基于 token 的实现会在改变曲线的同时把半径 token 乘以 1.25；本客户端没有半径 token（各组件 px 字面量），故半径不变，只改变圆角曲率。

## Alternatives considered

**先建半径 token 系统，再按 token 应用。** 更忠实，但把所有客户端包约 130 处 px 字面量半径改造成 token 是没有其他现实需求的大重构；通配选择器用一条规则触达同样的表面。

**对正圆形状也应用超级椭圆（不设豁免）。** 声明更少，但用 `border-radius: 50%` border 绘制的加载圈在形状不是圆时旋转会晃动，胶囊两端会变方。

**用子树级 `--dsw-corner-shape: round` 替代逐声明 `corner-shape: round` 豁免。** 自定义属性会继承，胶囊的圆角后代会静默失去平滑；逐规则显式声明让豁免范围恰好等于正圆形状本身，也是配对 spec 能检查的形式。

**在改变曲率的同时把半径乘 1.25。** 需要上述 token 系统；仅曲率变化已带来平滑感，半径维持设计值。

## Consequences

- 在支持 `corner-shape` 的引擎（Chromium ≥ 139，无需 flag）上，客户端每个圆角都沿 `superellipse(1.5)` 弯曲；其他引擎渲染与之前完全一致，没有回退代码。
- 新增正圆形状必须配对 `corner-shape: round`，否则 ui-theme 的 corner-shape spec 失败；该规则记录于 [docs/web-styling.md](../../../../docs/web-styling.zh.md)，每个圆或胶囊多付一条声明。
- 通配选择器给每个元素增加一个不继承的属性；声明是常量，在当前树规模下性能顾虑属于理论层面。
- 半径等于自身高度一半的圆角盒（低于 99px 的隐式胶囊）仍会得到超级椭圆；扫描看不到计算后几何，此类端部读作有意的平滑而非变形。
