# Agent Note: Turn 尾部统计 pill 与锚定弹层

Status: implemented
Archived: 2026-09-04

[English](2026-08-28-web-turn-stat-pills.md) | 中文

## 问题

助手 Turn 完成后尾部有上下两行 footer：图标操作行上方的 `本轮用量` DisclosureRow，加上操作行内以纯文字承载时钟、用时、首 token、解码速度的 meta 行。折叠行行内展开会推移下方的对话内容；meta 行混杂了两级受众——普通读者只关心时钟和用时，token 分桶与延迟数据属于诊断信息；长对话里每个 Turn 下都重复这两行占位。

## 决定

尾部只保留一行 `MessageIconActions`。分叉操作右侧放两个统计 pill：数据库图标 pill 标注紧凑的本轮总量（`用量 15.8K tok`），时钟图标 pill 标注墙钟用时（`用时 19秒`）；消息时钟保持纯文字置于行尾。每个 pill 是 `aria-haspopup="dialog"` 触发器，把固定定位的弹层 portal 到 `document.body`，由 `useAnchoredPosition` 锚定在触发器上方并保持 12px 视口边距，外部 pointerdown 或 Escape 关闭（沿用 ContextMeter 模式）。用量弹层承载精确总量、提供方/模型路由、缓存命中率、token 分桶及输出内联的推理子集；用时弹层承载本轮总用时、解码 TPS、本轮首 token 用时（取首个 step 的 TTFT）。fold 未产出的事实不渲染行，窗口内无可发布的 Turn 用量则不渲染用量 pill；token-meter fold 与 `turn/start` 门控沿用[精确 per-Turn 用量](2026-08-24-web-per-turn-token-usage.zh.md)，未做改动。

行可见性按新近度门控：turn 尾行与用户行标记 `data-actions-reveal`，各自最新一行保持 `always` 常显，更早的行在 `@media (hover: hover)` 下 hover 或 focus-within 才显示，无 hover 设备恒显示。480px 以下 pill 隐藏文字并取同排操作按钮的几何——28px 宽、6px 内边距、图标居中、取消相邻 pill 的边距补偿——让裸图标保持行的 8px 节奏。

## 备选方案

**整行扁平触发器。** TEMPORARY `?usage-variant=flat` 开关曾把两种布局同时交付真实 A/B 会话；扁平行把首 token、TPS、缓存命中率全部外露，读起来像普通元数据、点击暗示弱，且单一弹层堆叠两段无关内容。双 pill 胜出后，开关、其 locale key 与其测试一并删除。

**保留行内折叠行。** 否决：展开推移对话内容，且摘要行让诊断数据在每个 Turn 下永久占据第二行。

**用 hover tooltip 替代弹层。** 否决：七项事实需要可持久、可聚焦的面板，且 hover 无法服务 reveal 门控已豁免的触屏设备。

## 影响

`TurnUsageDisclosure` 及其样式表删除；`TurnUsagePanel` 拥有两个 pill 与弹层，`ui-chat` 为 portal 新增 `react-dom` 依赖。所有含助手尾行的 web ARIA golden 由 `text: Ran for …` 机械变为带标签按钮。组件测试钉住触发器文案、弹层内容、缺失事实的省略与两条关闭路径；样式契约测试钉住 pill 的次级字号、新近度门控与 480px 收缩；turn-tail e2e 在录制会话上驱动两个弹层，并确保 tok/s 与 TTFT 不出现在尾行。
