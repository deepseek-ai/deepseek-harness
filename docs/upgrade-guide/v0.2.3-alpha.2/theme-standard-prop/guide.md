---
kind: upgrade-guide
description: "Every Slot component now receives a required useTheme standard prop, so hand-built complete props need it and plugins drop their private theme sources."
---

# `useTheme` standard prop

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, a Slot component could read the theme only through a source its own plugin injected, such as `hooks: { theme: { getSnapshot: () => ctx.theme.getTheme(), subscribe: … } }`. After upgrading, [ui-theme](../../../../packages/client/ui-theme/README.md#use-this-package) publishes `useTheme(selector, isEqual?)` to every Slot scope as a member of `GlobalStandardProps`, before it provides the `theme` service. The [Framework-provided hooks](../../../subsystems/slots.md#framework-provided-hooks) table lists it.

TypeScript code that builds a complete `GlobalStandardProps` object by hand, such as component tests, fails to compile until it supplies `useTheme`. `SlotTestRuntime` publishes a light built-in theme by default.

## Migration

1. In hand-built props, spread `themeHooks()` from `@deepseek-ai/dsh-client-test-runtime` beside `responsiveHooks()`; pass `themeHooks({ colorScheme: 'dark' })` for the dark palette, or supply `useTheme: selector => selector(snapshot)` with a `themeSnapshot()` value.
2. In a plugin that injected its own theme source, delete that `hooks.theme` member, keep `'theme'` in the plugin's `inject` list, and read `props.useTheme` in the component. Branch on `active.colorScheme`, not on `preference` or the theme id.
3. With `SlotTestRuntime`, change the palette through `runtime.theme.set(themeSnapshot({ colorScheme: 'dark' }))`. Call `runtime.releaseThemeSource()` before mounting the production ui-theme plugin, which publishes the same prop.
4. Run `pnpm run typecheck`: no errors report a missing `useTheme`.
