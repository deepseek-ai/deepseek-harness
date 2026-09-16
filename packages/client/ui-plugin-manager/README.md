---
description: "Manage the profile's plugin bundles and their rows from the Web sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

English | [中文](README.zh.md)

## Summary

Use the **Plugins** entry in the Web sidebar to manage the profile's installed bundles and the official bundles the installation ships switched off. Switch bundles and their rows on and off, install a bundle after the Host has read what the spec names, watch pnpm's output, stop a run, and enable what it added. Uninstalling asks for confirmation. Global configuration remains in Settings.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Select **Plugins** in the sidebar. The page reads the inventory and the bundles through `api-remotes` when first opened; a Host without a managed profile shows the page as unavailable. **Built in** comes first and lists the bundles the installation ships for switching on, each tagged official, off until switched on and without an uninstall; **Installed** lists the bundles the profile holds. Cards are listed by name, so switching a bundle on or off does not move its card. A dependency without a bundle patch is not a plugin and is not listed unless the profile selects it, in which case it carries a problem tag. Global configuration remains in the Settings **Plugins** section.

### Installing a bundle

**Add plugin** takes a package name with an optional version, a Git address, a tarball, or an absolute local path; the dialog says a package name is what follows `dsh plugin add` in a README. **Not sure what to enter?** under the field opens a guide that shows the three common forms with an example each; **Use example** drops one into the field. **Install** first asks the Host to read what the spec names (`pluginManager.inspect`): a name the list already shows, a name the registry does not have, a path without a package, a package without a bundle patch, or a spec pnpm would refuse comes back under the field as one sentence, with the spec kept for editing. An accepted spec opens the installing screen, which shows the package's name, one-liner, and version as the Host read them and folds pnpm's command and output behind **Show install details**. A finished install offers **Enable now**, which switches the new bundle on, closes the dialog, and scrolls the list to it; closing instead leaves it installed and off. A failed install says what went wrong in one line — the registry or network could not be reached, the package was not found, the disk is full, the profile is not writable, pnpm blocked a build script — with pnpm's output behind the details and **Retry** at hand; the Host has already put the profile files back. When pnpm blocked a dependency's install scripts, the failed screen lists the packages whose scripts wait for permission and offers **Allow these scripts and retry** in place of **Retry**; the Host saves the permission in the profile's `pnpm-workspace.yaml`, which a failed run leaves as pnpm wrote it, then runs pnpm again, and the installed screen names what was allowed. A successful installation does not certify that a module can activate.

During installation, **Cancel install** asks the Host to stop the run and shows **Stopping installation…** until the Host confirms. Loading the bundle cannot be cancelled. Once confirmed, the dialog returns to the spec, ready to install again, and a toast says the installation was cancelled; the manifest and lockfile are back as they were, while downloaded files can remain. Closing the dialog is blocked while the Host owns the operation. A connection error does not confirm cancellation: the running screen says so and cancelling can be tried again.

### Switching a bundle

A bundle's page shows its full package name under the title, the spec that installs it elsewhere. A bundle's switch changes its layer selection. A profile with HMR recomposes before the operation completes; one without HMR, and a bundle a higher layer overrides, say so in a toast. A bundle the Host cannot read carries a problem tag and its reason on its page and cannot be switched on; one that provides the management components stays locked. The Host answers with error codes, which the page's dictionary words; pnpm's and the Loader's own diagnostics are shown as they are. The installation's own bundles are not on the page; the Settings Plugins section's Plugin list tab inspects them.

### Switching one row of a bundle

A row's switch on the bundle's page calls `pluginManager.setPluginEnabled`, which writes the row's `disabled` override into the profile's `cordis.patch.yml`. The tree recomposes at once on a profile with HMR, so the row's host half unmounts or mounts while the rest of the bundle keeps running, and the page follows the client module graph without reloading. Rows show their fiber phase as the Host runs them. The switch appears only on a bundle that is on; a row without a live entry, or one the Host will not address through the profile patch, is locked with the Host's reason. A list longer than ten rows gets a filter over the row ids.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Package management uses the profile's dependency records: installed bundles can be toggled and removed; installation-owned bundles remain locked. This distinction does not select startup failure policy.

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The browser plugin registers the `plugins` sidebar entry and its `main` panel through `ctx.slots.inject()`, so both follow late slot declaration, locale changes and teardown. The page is global and belongs to no Session. Display text comes from package metadata and the page's dictionary.

### The store

`PluginManagerController` owns the bundle views, busy keys, notices, install progress and the uninstall confirmation. Each read asks the inventory whether the Host manages a profile, then joins `listBundles` with `listPlugins` into one view per bundle, whose rows carry the live entry's enablement and fiber phase. It coalesces overlapping reads, refreshes after operations, on `plugin-manager/changed`, and on reconnect, and ignores late results after disposal. Install output is grouped by job id. The install dialog moves `idle → checking → starting → running → done | failed`, with `cancelling` and `applying` as the Host reports them. The check runs under an `AbortController` that going back or closing aborts, and its settlement is dropped; a run is stopped only through `pluginManager.cancelInstall`, whose answer the dialog waits for. A change the Host could not apply, a restart it waits for, and an override by a higher layer become toasts that retire on their own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the sidebar, the Remote calls, and the Host-side manager.

- [ui-sidebar](../ui-sidebar/README.md) — the panel list the Plugins entry registers into; [ui-layout](../ui-layout/README.md) — the main slot the page occupies.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `pluginManager.*` and `pluginInventory.*`.
- [plugin-manager](../../boot/plugin-manager/README.md) — the Host-side manager this page drives.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side management surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the reach of the management view; they are current package constraints.

- **Only bundles are managed** — a dependency without a bundle patch is refused before it installs; one the profile already holds is left off the page unless the profile selects it, and loading plain plugin modules stays a file operation.
- **Rows show a phase, not a reason** — a failed row reads as failed without the Host's error text; the Host log has it.
- **One install at a time** — the dialog runs one pnpm command; a second spec waits for the first to finish.
- **No version picker** — the spec is typed as pnpm accepts it; the page neither lists registry versions nor offers upgrades.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns a sidebar panel over Host-owned facts.
