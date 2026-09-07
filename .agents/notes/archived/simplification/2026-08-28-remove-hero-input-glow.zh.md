# Agent Note: The hero input glow is removed

Status: implemented
Archived: 2026-09-04

[English](2026-08-28-remove-hero-input-glow.md) | 中文

## Problem

New Session 首页曾在输入卡片下方绘制一个装饰性背景椭圆(`HeroGlow`,figma 313:14109):一个模糊的蓝色渐变,尺寸为 hero 盒子的 `1051/776`,使其 `stdDeviation="50"` 模糊随卡片缩放。在实际交付的 token 表下,这个椭圆看起来是意外的蓝色沾染而非有意的装饰,并且它按构造就会溢出会话列,迫使列本身背上裁剪脚手架。

脚手架的由来:单轴滚动的盒子会把另一轴初始的 `visible` 推导为 `auto`,glow 的溢出让 `[data-conversation-scroll]` 在笔记本宽度下出现 24–95px 的真实横向滚动范围,当时(2026-08-04)靠在 `.scrollBody` 上声明 `overflow-x: hidden` 修补。本 note 取代并合并了那个 bug-fix note。

## Decision

`HeroGlow` 连同其定位脚手架一并删除:组件本体及其在 `EmptyHero.tsx` 中的座位、`ConversationRoot.module.css` 中为 glow 开的 z-index 例外,以及 `.scrollBody { overflow-x: hidden }` 裁剪——后者除 glow 的溢出外没有任何持有者。滚动主体的横轴回到推导值,当前列下没有任何元素溢出。

e2e 场景 `conversation-column-overflow.e2e.ts` 及其 golden 随 glow 一并删除:该测试的空洞防护(vacuity guard)断言 glow 在窄档位仍然溢出列,因此一旦没有任何东西溢出,它按设计就无法通过。

## Alternatives considered

**保留 glow 只调整颜色。** 拒绝。这不是一个待修正的 token 错误;产品判断是首页输入卡片根本不应携带背景装饰。

**保留 `overflow-x: hidden` 作为防御性裁剪。** 拒绝。glow 删除后该声明没有当前持有者,而仓库要求每项内容都有;静默裁剪还会把下一次意外溢出藏起来,而不是在评审中暴露它。

**保留 overflow 测试防范未来溢出。** 拒绝。它的空洞防护要求当下存在一个正在溢出的元素,场景无法在不改写成另一个测试的前提下表达"没有东西溢出";composer 几何 golden 已经按 tab 钉住了滚动主体的 `overflow` 两轴取值。

## Consequences

hero 栈成为共享输入卡片上方的朴素装饰,glow 组件、座位接线和裁剪脚手架共 67 行被删除。代价是失去常驻防线:会话列重新只靠构造保持单轴滚动,未来任何溢出列的装饰元素都会重新推导出 `overflow-x: auto` 并出现横向滚动条。重新引入溢出者必须在 `.scrollBody` 上恢复显式单轴裁剪并补上手势级回归测试——断言 `scrollWidth === clientWidth` 不能替代,因为裁剪只是隐藏范围而非将其回流消除,只有被拒绝的滚轮手势能区分两种状态。composer tab 几何 golden 记录了当前 `overflow auto/auto` 的读数,推导翻转回去时会报警。
