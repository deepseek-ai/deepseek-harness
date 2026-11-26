---
kind: upgrade-guide
description: "每个 Slot 组件现在都会收到必需的 useTheme 标准 prop，手工构造的完整 props 需要补上它，插件也不再注入私有主题源。"
---

# `useTheme` 标准 prop

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，Slot 组件只能通过本插件注入的源读取主题，例如 `hooks: { theme: { getSnapshot: () => ctx.theme.getTheme(), subscribe: … } }`。升级后，[ui-theme](../../../../packages/client/ui-theme/README.zh.md#use-this-package) 在提供 `theme` 服务之前，把 `useTheme(selector, isEqual?)` 作为 `GlobalStandardProps` 的成员发布到所有 Slot scope；[框架提供的 hooks](../../../subsystems/slots.zh.md#framework-provided-hooks) 表已列出它。

手工构造完整 `GlobalStandardProps` 对象的 TypeScript 代码（例如组件测试）在补上 `useTheme` 之前无法通过编译。`SlotTestRuntime` 默认发布浅色内置主题。

## 迁移

1. 在手工构造的 props 中，在 `responsiveHooks()` 旁展开 `@deepseek-ai/dsh-client-test-runtime` 的 `themeHooks()`；深色调色板传 `themeHooks({ colorScheme: 'dark' })`，也可以用 `themeSnapshot()` 的值提供 `useTheme: selector => selector(snapshot)`。
2. 如果插件注入过自己的主题源，删除该 `hooks.theme` 成员，在插件的 `inject` 列表中保留 `'theme'`，并在组件中读取 `props.useTheme`。明暗分支判断 `active.colorScheme`，不判断 `preference` 或主题 id。
3. 使用 `SlotTestRuntime` 时，通过 `runtime.theme.set(themeSnapshot({ colorScheme: 'dark' }))` 切换调色板。挂载生产 ui-theme 插件之前调用 `runtime.releaseThemeSource()`，因为该插件会发布同名 prop。
4. 运行 `pnpm run typecheck`，确认没有缺少 `useTheme` 的错误。
