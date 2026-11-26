---
kind: upgrade-guide
description: "contextMenu.button Factory 与 conversation.hero.brand.mark slot 不再接受调用方传入的 className；菜单按钮改为接受 size。"
---

# 菜单按钮与首屏品牌标志移除 className

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，调用方可以通过 `renderFactorySlot('contextMenu.button', { className })` 传入自己的 CSS 类，[Conversation](../../../../packages/client/ui-conversation/README.zh.md) 空白首页也会向 `conversation.hero.brand.mark` 的占用方传入 `className`。启用[包样式隔离](../../../../packages/client/ui-renderer/README.zh.md#package-style-isolation)后，一个包的类无法作用到另一个包的 DOM，因此两个属性都已移除。在任一调用中传入 `className` 都会被 TypeScript 拒绝。

[菜单按钮](../../../../packages/client/ui-context-menu/README.zh.md)现在自行负责样式，并接受 `size?: 'sm' | 'row'`。`size: 'sm'` 仍显示标签提示，按钮由 36px 宽的紧凑基础按钮改为 28px 正方形，内含 15px 的二级色图标。`size: 'row'` 为新增取值：24px 点击热区、-4px 外边距，内含 14px 的三级色图标，不显示提示。省略 `size` 时仍渲染不带样式的原生按钮。

`conversation.hero.brand.mark` 的占用方现在只收到 `{ size }`。首屏的颜色、溢出与悬停摆动只作用于它自己的后备鲸鱼标志。

## 迁移

1. 从每个 `renderFactorySlot('contextMenu.button', …)` 调用中删除 `className`。列表行里的按钮传 `size: 'row'`，工具栏控件传 `size: 'sm'`，并删除调用方给按钮写的样式规则。
2. 依靠容器规则给未指定尺寸的按钮定样式的插件，在不隔离时照常工作；启用隔离后，这些规则不再命中 Factory 内的按钮。
3. 在注册到 `conversation.hero.brand.mark` 的组件中不再读取 `props.className`，改用本包自己的类为标志设置颜色和动效。
4. 运行 `pnpm run typecheck`，确认不再有 `className` 相关错误。在 Web 界面中把调用方的隔离设为 `style`，确认按钮尺寸仍符合预期。
