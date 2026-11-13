---
kind: upgrade-guide
description: Client artifact metadata and static library manifests require rebuilding custom browser bundles and updating direct static-artifact consumers.
---

# Client module metadata

English | [中文](guide.zh.md)

## Change

Client bundle registrations can carry `meta` beside `id`, `factory`, and optional `chunk`. The factory still returns the plugin or library exports. Metadata optionally contains `stylesheets`, a record keyed by each stylesheet's path within the owning package, such as `src/client/App.module.css`; each descriptor has `text(context)`, with `context.asset()` resolving carrier asset URLs. Compiled stylesheet imports no longer install DOM nodes during JavaScript factory execution.

Static Client library index artifacts keep their named exports and add one more, `__$dsh_client_module_manifest`, carrying the same manifest; its factory returns the library's exports without the manifest. Their ESM imports and dynamic imports remain in the final Web build.

Styles of `staticLinked` libraries, including `dsh-client-ui-primitives` and `dsh-client-ui-dockkit`, leave the Web shell's CSS file: the renderer installs them when the application mounts. Their CSS Modules class names change from `_<local>_<hash>` to `<hash>_<local>`. Generated style elements keep `data-plugin` with the owning package, add `data-path` with the stylesheet's path within that package, and no longer carry `data-plugin-css`.

A bundle built with this preset loads on earlier DSH releases without its styles, because they ignore `meta`. Earlier-preset bundles still inject their own `<style data-plugin>` elements, which Modules no longer removes: disabling or live-replacing such a plugin leaves its styles until reload, and an earlier-preset replacement keeps the old text.

The default startup order is unchanged: Modules constructs its Main environment from the existing loading hook, prefetch runs before Loader activation, and renderer installation adds materialized-module styles before the React root. Realm Registry and iframe providers are optional; there is no Isolation or Shadow DOM configuration in this change.

## Migration

1. Rebuild custom Client bundles with the matching `clientBundle` preset. Custom artifact generators that provide compiled CSS expose its descriptors through `meta`; artifacts without metadata can omit it. Do not add metadata to `factory()`'s returned business exports.
2. Rebuild `staticLinked` libraries and the consuming shell together. Shell assembly reads the `__$dsh_client_module_manifest` export; plugin code keeps its existing package specifiers and obtains exports through the module loader's `require`. Code that enumerates a static library's namespace sees this additional key.
3. Keep carrier asset resolution available through `context.asset()` when generating stylesheet text. Leave DOM installation to the renderer; module factories no longer own generated style tags.
4. Verify that registrations do not evaluate metadata, CSS appears before the application root renders, lazy metadata appears only after its module materializes, and module replacement removes or updates the prior styles. The [module reference](../../../../packages/client/modules/README.md) and [renderer reference](../../../../packages/client/ui-renderer/README.md) define ownership and failure behavior.
5. Replace selectors in custom CSS, user scripts, and tests that match generated class names such as `[class*="_header_"]` with `data-*` attributes or accessible roles, and `style[data-plugin-css]` with `style[data-plugin][data-path]`.
6. Set the rebuilt plugin's `engines.dsh` minimum to the DSH release with this change. Reload the page after disabling or updating an earlier-preset plugin.
