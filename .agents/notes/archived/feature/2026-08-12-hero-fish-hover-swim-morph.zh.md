# Agent Note: 主页鲸鱼 hover 游动变形

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-hero-fish-hover-swim-morph.md) | 中文

## 问题

hover New Session 主页的鲸鱼（`dsh-client-ui-conversation` 的 `EmptyHero.tsx`）原本只播放一次整个 svg 的刚性 CSS 摇摆。用户希望鲸鱼有真实的游动感——尾巴摆动、嘴巴曲线上扬，这要求对路径几何本身做变形。CSS transform 无法弯曲路径中的部分曲线，且 logo 以单一 `FISH_LOGO_PATH` 字符串存放在 `dsh-client-ui-primitives`。

## 决定

通过 SMIL `<animate attributeName="d">` 做真实曲线变形，按与 CSS 摇摆相同的 1.6s 周期循环 `静止 → 尾上摆 → 静止 → 尾下压 → 静止`；CSS 摇摆改为持续循环（`infinite`），指针停留多久就游多久。两个变形目标由程序生成（在 `/tmp` 运行的脚本，未入库）：解析 `FISH_LOGO_PATH` 的绝对 M/C/L/Z 命令，尾部区域绕支点做带 smoothstep 衰减权重的旋转，嘴巴/鳍的内侧曲线以距身体锚点的权重平方做竖直弯曲（微笑式上扬，而非刚性摆动——刚性旋转看起来与身体脱节），并输出结构完全一致、SMIL 可插值的命令串。烘焙出的路径常量与组件放在一起，并在注释中记录生成参数。SMIL 无法响应 CSS 媒体查询，因此用经 `matchMedia('(prefers-reduced-motion: reduce)')` 判定的 `hovering` 状态控制变形挂载，CSS 摇摆则在 `@media (hover: hover) and (prefers-reduced-motion: no-preference)` 之下。

变形鲸鱼以 `conversation.hero.brand.mark` slot 的 fallback 身份进入主页；没有任何发布包占据该 slot——`dsh-client-ui-brand-official` 只填充侧栏槽位，因为 feature 插件不得跨包 value-import `HeroFish`（[client 跨包规则](../process/2026-08-23-client-cross-package-value-dependencies.zh.md)），而 fallback 本身就是官方标志。`FISH_LOGO_PATH` 与 `FISH_LOGO_VIEWBOX` 从 `dsh-client-ui-primitives` 导出，供围绕同一几何自行组装 svg 的消费方使用。

## 考虑过的替代方案

**用矢量工具编辑路径做变形。** 流程中没有可交互的工具；选择程序化加权变形，因为它保证 SMIL `d` 插值所要求的完全一致的命令结构，且振幅是可评审的数字。

**hover 气孔喷水。** 按用户要求移除；hover 只保留形状变形与摇摆。

**让官方标志占据主页 slot。** 即先前的安排；否决，因为静态 occupant 会遮住动画 fallback，而给 occupant 加动画又需要被禁止的跨包 value import。

## 影响

hover 游动是纯装饰（`aria-hidden`）且对 reduced-motion 安全（hover 保持静态 logo）。摇摆 CSS 作用于外层静止的 `.fishHitbox`，因此换成 slot occupant 也会摇摆；身体变形只存在于 fallback 的 `HeroFish` 中。覆盖由 `skeleton.client.spec.tsx` 断言 slot 合约（名称、owner props、fallback 存在性）；keyless 快照体系记录对话转录而非浏览器动画，变形的视觉验证仍需人工。重新生成变形目标需要对 `FISH_LOGO_PATH` 重跑（未入库的）变形脚本；若 logo 几何将来变化，烘焙常量必须随之重新生成。
