---
kind: upgrade-guide
description: "ui-slots, ui-primitives, and ui-dockkit become dynamic plugin packages with immediately: true: `<package>/client` is the recommended specifier, the package root in Node is an empty Host entry, and a full Web composition must list their rows."
---

# Three Client packages become `immediately` dynamic plugin packages

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, the Web shell linked `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, and `@deepseek-ai/dsh-client-ui-dockkit` statically: the package root was browser ESM with a `__$dsh_client_module_manifest` export. After upgrading, each is a dynamic plugin package with `immediately: true`, like `ui-renderer`. Its row loads before other plugins, and its `./client` export, `lib/client.js`, registers the package's module with the module loader, so other bundles can require its exports. These `/client` value exports remain for now and will be reduced over time. `@deepseek-ai/dsh-client-store` is unchanged and stays statically linked.

The recommended specifier for values, types, and `declare module` augmentations is `<package>/client`. For code written against the package root, the packages adjust their exports and types, and DSH keeps two compatibility commitments, each pinned by tests:

- **TypeScript.** Code may import types from the package root and augment it with `declare module '<package>'`, alone or mixed with the `/client` spelling in one file or across files: the published root `types` and `./client` types are one declaration file, so every spelling reads one merged interface. [`verify-client-package-consumer-types`](../../../../scripts/verify-client-package-consumer-types.ts) compiles the [external consumer fixtures](../../../../scripts/fixtures/client-package-consumer/) under NodeNext and Bundler resolution.
- **Browser.** A built plugin's `require('<package>')` returns the same exports as `require('<package>/client')` from the module table ([unit test](../../../../packages/client/modules/tests/loader.client.spec.ts), [browser test](../../../../apps/web/tests/client-package-specifiers.e2e.ts)).

Everything else follows the new form. In Node the package root is the Host entry `lib/index.js`, which exports only an empty `apply` and no other values; the `__$dsh_client_module_manifest` export no longer exists; the Web client has these packages only when its composition lists their rows. Their exported APIs remain pre-stable. The [Agent Note](../../../../.agents/notes/implemented/architecture/2026-11-27-client-packages-as-immediately-dynamic-plugins.md) records the decision.

This affects tests and tools that run these packages' code in Node or read the manifest export, and custom `cordis.yml` files that compose the full Web client.

## Migration

1. Name these packages through `<package>/client`, for example `import { Button } from '@deepseek-ai/dsh-client-ui-primitives/client'` and `declare module '@deepseek-ai/dsh-client-ui-slots/client'`. Existing package-root imports and augmentations keep compiling and loading in the browser.
2. Tests that run browser code in Node import these packages' values from `<package>/client` and resolve it to `src/client/index.ts`, as the repository's tsconfig paths do, or alias the exact package root to `<package>/client`.
3. A custom `cordis.yml` that replaces the bundled Web client composition adds these rows before `ui-renderer`, as [`packages/bundle/web-app/cordis.patch.yml`](../../../../packages/bundle/web-app/cordis.patch.yml) does:

   ```yaml
   - id: ui-slots
     name: '@deepseek-ai/dsh-client-ui-slots'
   - id: ui-primitives
     name: '@deepseek-ai/dsh-client-ui-primitives'
   - id: ui-dockkit
     name: '@deepseek-ai/dsh-client-ui-dockkit'
   ```

4. Confirm by opening the Web client: the application mounts without a boot failure, and `window.__DSH_BOOT__.entries` in the page lists the three package names with `immediately: true`.
