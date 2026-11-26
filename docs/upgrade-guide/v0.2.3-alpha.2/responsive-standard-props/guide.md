---
kind: upgrade-guide
description: "Hand-built Web Client Slot props must supply the responsive and document hooks."
---

# Responsive and document standard props

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, Web Client components that branched on a media query or on the device class called `window.matchMedia` or `isMobileDevice()` themselves. After upgrading, `GlobalStandardProps` requires `useMediaQuery(query)` and `useMobile()`, which the `uiResponsive` service of the new `@deepseek-ai/dsh-client-ui-responsive` Client plugin publishes to every Slot scope; see [Framework-provided hooks](../../../subsystems/slots.md#framework-provided-hooks). The composer, the right Sidebar expand button, the agent-preset chip, the desktop onboarding flow, the model selector, and the Session panel read them, as do the experimental Session Inspector and Forge; their plugins inject `uiResponsive`. Profiles that run the shipped Web bundles need no configuration change.

TypeScript code that builds complete Slot props by hand must supply those two hooks and the renderer's `useDocumentPortal()` and `useDocumentViewport()`. The document hooks need no `uiResponsive` injection. A custom Web roster that omits `@deepseek-ai/dsh-client-ui-responsive` no longer starts these plugins, because their media and device hooks require the `uiResponsive` service.

## Migration

1. In hand-built props, spread the fixed-answer Hooks of `@deepseek-ai/dsh-client-test-runtime`. Without options they describe a desktop device on which no media query matches:

   ```tsx
   import { responsiveHooks } from '@deepseek-ai/dsh-client-test-runtime'

   const props: ExpandButtonProps = { ...standard, ...responsiveHooks({ mobile: true }) }
   ```

   Pass `matches: query => query === '(prefers-reduced-motion: reduce)'` to ask for reduced motion. Replace `window.matchMedia` and `isMobileDevice` stubs that chose these components' answers with these options.
2. Specs that render through `SlotTestRuntime` already receive `responsiveHooks()` and a `uiResponsive` stand-in service. Call `await runtime.releaseResponsiveSource()` before mounting the production service.
3. In a plugin whose components read `useMediaQuery` or `useMobile`, add `'uiResponsive'` to its `inject` list so it starts after both props exist and unloads with them.
4. In a custom Web roster, add a `dsh.client` row named `@deepseek-ai/dsh-client-ui-responsive`, and its package dependency, wherever one of the plugins above is enabled.
5. Confirm the migration: the client test typecheck and the tests pass, and the page renders the composer, the model selector, and the Session panel.
