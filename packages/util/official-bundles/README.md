---
description: "Installation-owned lists of official dsh bundles (shipped profile templates, the default list, and the optional, on-demand, and retired bundles) and the plugin manager's protected and presented packages."
kind: "package-library"
---

# @deepseek-ai/dsh-official-bundles

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-official-bundles` holds the bundle package names the dsh installation decides on: which bundles each shipped profile starts with, which bundles it ships switched off, which official bundles install on request, which bundles earlier releases shipped and profiles drop, and which packages the plugin manager protects, hides, orders, or marks experimental. [`dsh-app-boot`](../../boot/app-boot/README.md) applies these lists when it loads a profile; the plugin manager, the CLI, Desktop, the image packer, and repository checks read them directly. The package holds data only, so changing a list leaves app-boot and the plugin manager untouched. Use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Edit this package when the installation's bundle selection or the plugin manager's protected or presented packages change; read it wherever code must agree with the launcher about that selection.

### Profile templates

`PROFILE_TEMPLATES` maps each shipped profile name (`web`, `headless`, `acp`, `sdk`, `sdk-minimal`) to its ordered bundle layer list. App-boot initializes a missing shipped profile from its template, and `dsh --profile <name> --from-default-profile <template>` copies one into a custom profile. `DEFAULT_PROFILE_BUNDLES` is the list `dsh plugin` uses for a profile name with no template. `INSTALLATION_OWNED_PROFILE_TUPLES` names bundle lists that an earlier release wrote into a shipped profile; app-boot replaces an exact match with the current template.

### Optional and retired bundles

`OPTIONAL_BUNDLES` names the bundles the installation ships for a person to switch on. Each must be a runtime dependency of the `dsh` app that declares `dsh.bundle.patch`, an icon, and `./locale/*.json` display metadata, and no template may select it; [`verify-default-product-isolation`](../../../scripts/verify-default-product-isolation.ts) checks these rules. The [plugin manager](../../boot/plugin-manager/README.md#use-this-package) reports these bundles as `optional`. `RETIRED_BUNDLES` names bundles the installation no longer carries; app-boot removes them from a profile's bundle list when it loads the profile.

<a id="plugin-manager-lists"></a>
### Plugin manager lists

`PROTECTED_PLUGINS` names the plugin packages the [plugin manager](../../boot/plugin-manager/README.md) keeps read-only because management needs them; a bundle that contains one is a management bundle. Removing a name drops only this `management-required` refusal; the manager's own entry, installation-carried bundles, and unaddressable rows stay protected by their own rules. The [Web plugin page](../../client/ui-plugin-manager/README.md) hides the `HIDDEN_BUNDLES`, ranks the `EXTENSION_BUNDLES` first in their order, keeps the `MORE_BUNDLES` off its main list until the profile enables them, and marks the `EXPERIMENTAL_BUNDLES` with the Experimental badge.

### On-demand bundles

`ON_DEMAND_BUNDLES` names the public Official packages installed only on request. `OFFICIAL_ON_DEMAND_CATALOG` embeds their package-owned localized metadata, icons, and optional `dsh.bundle.platforms` declarations for offline discovery and Host platform checks before installation; `pnpm gen-official-bundle-catalog` explicitly updates generated content, and `verify-official-bundle-catalog` checks resource completeness and freshness; builds consume the committed catalog without importing provider code. The catalog contains no install target: the plugin manager derives it from the running version and installation and uses the ordinary bundle installer. The [product-use check](../../../scripts/verify-product-use.ts) composes shipped and on-demand selections against Web without executing providers. The catalog also preserves `listedByDefault` so a default-hidden bundle stays hidden until explicitly installed or enabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Repository checks read the lists in `src/bundles.ts` as TypeScript literals without executing them, so each list stays a static array or object literal of package names. `INLINE_SAFE` in [`tsdown.client.ts`](../../client/tsdown.client.ts) lets Client bundles inline this whole package, so every export stays data with no runtime identity to share. `ui-plugin-manager` imports the Web lists from the package root, and tree-shaking keeps the profile templates and the generated catalog out of its bundle while no Client code imports them.

### Source map

| File | Role |
|---|---|
| [`src/bundles.ts`](src/bundles.ts) | Profile templates and the default, installation-owned, retired, optional, and on-demand bundle lists |
| [`src/plugin-manager.ts`](src/plugin-manager.ts) | Protected plugin packages and the Web plugin page's hidden, ordered, and experimental bundle lists |
| [`src/catalog.generated.ts`](src/catalog.generated.ts) | Generated offline metadata for the on-demand bundles |
| [`src/index.ts`](src/index.ts) | Public exports and the catalog entry type |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-app-boot](../../boot/app-boot/README.md) — profile loading that applies the templates and retired list.
- [Shipped optional bundles](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md) — why the installation owns the optional list.
- [Official on-demand bundles](../../../.agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.md) — the offline catalog decision.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Lists are compiled into the installation** — changing a list requires a new dsh release; a profile cannot extend the optional or on-demand lists.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
