---
kind: upgrade-guide
description: "原先依靠会话面板开关把输出元素画成圆点的插件，升级后需要自行设置角标样式。"
---

# 在会话面板开关上绘制角标

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，注册到 `conversation.session.panel.indicator` 的插件只需给元素设置底色并提供状态文字，开关就会设置元素尺寸和圆角，并绘制外圈。升级后，开关在图标右上角放置一个共用的 6×6 px 容器，不为其中的元素设置样式，因此只设置底色可能看不到圆点。

## 迁移

1. 保留注册项的 `id`、`order` 和已有的 `panelShown` 判断。没有状态要提示时返回 `null`。显示圆点时，在元素内保留本地化的状态文字，仅在视觉上隐藏，让开关的无障碍名称仍包含这段文字。
2. 给插件自己渲染的元素添加样式类，不要把样式加在共用容器上。例如，以下规则会铺满可用区域，画出带外圈的圆点。请按状态选择底色。

   ```css
   .indicator {
     position: absolute;
     inset: 0;
     border-radius: 50%;
     corner-shape: round;
     background: var(--dsw-alias-state-business-primary);
     box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-base);
   }
   ```

3. 只触发自己的状态，确认图标右上角出现圆点，且开关的无障碍名称包含状态文字。清除状态后，圆点、外圈和状态文字都应消失。同时触发两个角标时，`order` 较高的角标显示在上方。
