# Agent Note: Web elevation — hairline stroke drawn in shadow

Status: implemented

[English](2026-09-01-web-elevation-stroke-shadows.md) | 中文

## Problem

Web 客户端的高层级表面——菜单、浮层、对话框、面板、悬浮按钮、输入框——原先都把真 `border: 1px solid <中性 token>` 与 `--dsw-shadow-lv2`/`lv3` 投影配对。border 占布局（每侧 1px，且在 `<button>` 上是对 UA 默认边框的替换）；浅色主题下多数浮层实际没有描边（`--dsw-alias-border-inverted` 在浅色下是透明的），靠 `lv3` 里模糊的 1px 环冒充；输入框则披着一大片柔和的 `lv2` 投影，读起来更像污渍而非悬浮表面。当前桌面聊天 UI 改用单个 `box-shadow` 列表绘制 elevation：0.5px 发丝描边加两层极淡柔光，表面本身 `border: 0`。

## Decision

`gradient-shadow-text.css`（ui-theme 的阴影归属地）在 `--dsw-shadow-lv*` 阶旁定义 elevation token：

- `--dsw-elevation-stroke-color`——发丝描边颜色，默认 `--dsw-alias-border-l4`（浅色黑 16%、深色白 20%）；组件可按表面或状态重绑：所有菜单面（`--dsw-specific-menu` 背景）重绑最浅的 `--dsw-alias-border-l1`、输入框重绑 `--dsw-alias-border-l2`，两者都比面板与按钮安静。默认色只声明在 `body` 上，而下述派生 token 在 `body, body *` 上逐元素重声明：自定义属性的计算值已替换完 `var()`，派生 token 若只在 body 声明会把 body 的颜色固化进去，让所有重绑失效（与 scrollbar.css 对 `--dsh-scrollbar-thumb` 声明的逐元素重替换是同一契约）。
- `--dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color)`——单独的描边，供只要轮廓的行内卡片独立使用（插件清单卡片）。
- `--dsw-elevation-panel` / `--dsw-elevation-prominent`——描边加两层极淡柔光（3px 方向光 + 16/20px 辉光，黑 2–5%），panel 用于小型悬浮部件与卡片，prominent 用于浮层，soft——更大模糊、更低透明度——用于输入框。

被转换的表面设 `border: 0` 加一个 elevation 投影：所有 `--dsw-shadow-lv3` 浮层（Menu、Modal、弹出选择、模型选择、用量/上下文浮层、反馈操作条、日程/任务浮层、子代理谱系、设置面板、cordis 面板、实验性 team 面板）取 prominent；lv2 表面（回到底部按钮、回合预览卡、附件栏箭头、问题 composer、轨迹 tooltip）取 panel。输入框卡片取 soft 档并重绑 l2 描边，其 workspace-trigger 态把描边色设为 `transparent`，替代原先的 `border-color: transparent`。深色主题无需投影覆盖：柔光在深色下几乎不可见，分离由描边承担。

`packages/client/ui-theme/tests/elevation-styles.client.spec.ts` 钉住 token 组成并扫描 `packages/` 下全部样式表：lv/elevation `box-shadow` 与 `--dsw-alias-border-*` border 配对的规则即失败；中性 `--dsw-alias-border-*` token 上的每个 `solid` border 必须为 `0.5px` 宽。有意保留：Toast 与 HoverCard（反色填充，跟随主题的描边色在其上无意义）、ImageLightbox（裸图片）、warn 描边的审批/计划面板——状态色 border 保持真 border，扫描放行。

平面部件保留真 border 但取发丝线宽度：所有中性 token 的 `1px solid` border——按钮（共享 outline 变体、添加/重试/inspect 按钮）、输入框、行内卡片、代码块与设置行分割线——改为 `0.5px solid`，整框描边加深为 `--dsw-alias-border-l4`（按钮浅一档取 `--dsw-alias-border-l3`），行分割线保持 `--dsw-alias-border-l2`；状态逻辑（focus/hover 换 `border-color`）不变。以填充盒绘制的分隔线取同一粗细：高或宽为 1px、背景用 border token 的线（菜单分隔、对话标题栏接缝、markdown `hr`、工具 IO 分隔、轨迹竖轨、目录浏览器分隔）改为 0.5px；上下文注入分隔线原先读取从未定义的 `--dsw-alias-line-secondary`（因此从未渲染），现在绘制 `0.5px solid var(--dsw-alias-border-l2)`。Chromium 把亚设备像素 border 绘制为一个设备像素，因此 1x 屏与原先渲染完全一致，2x 屏得到发丝线。dashed 记号保持 1px（0.5px 虚线图案会退化），两个用 border 画的 spinner 圆环经 spec 显式豁免保留轨道宽度。

## Alternatives considered

**保留 1px 真 border、只调柔投影。** 留下占布局的 border、浅色主题 `border-inverted` 浮层的描边缺口，以及两者并存处的双轮廓；描边入投影正是产生锐利发丝边缘的形式。

**用 1px 而非 0.5px 描边。** 0.5px 在 2x 屏渲染为一物理像素，1x 屏混合得更浅，正是发丝线意图。1px 读起来就是原来的 border。

**平面部件的发丝线也用 box-shadow 描边画。** 按钮与输入框在 hover/focus 时切换 `border-color`，多处还配 box-shadow 焦点环；把描边挪进 `box-shadow`（单一属性）会与焦点环冲突并重写全部状态规则，而 `0.5px solid` 保留整套状态逻辑，只改粗细。

**composer trigger 态用 `box-shadow: none` 抑制描边。** 会连带丢掉该状态今天保留的柔光；重绑 `--dsw-elevation-stroke-color: transparent` 恰好只去掉描边。

**Toast/HoverCard 一并转换。** 其填充相对主题反色，跟随主题的描边色在其上不可见或错误；在出现反色表面描边 token 之前保留 `lv3`。

## Consequences

- 每个被转换表面在浅色主题下获得发丝轮廓（多数浮层此前没有），盒子少了 1px border；视觉尺寸变化在小按钮上至多 2px，面板上不可察觉。
- 中性 border 加投影的配对现被 ui-theme elevation spec 拒绝，新的高层级表面必须选用 elevation token；规则记录于 [docs/web-styling.md](../../../../docs/web-styling.zh.md)。
- 输入框的大片 `lv2` 变为描边加收紧的辉光；深色描边经重绑保留 figma 低一档取值。
- `--dsw-shadow-lv1`/`lv1-blur` 目前无消费方，`lv2`/`lv3` 只剩有意保留者；该阶为反色与定制表面继续存在。
