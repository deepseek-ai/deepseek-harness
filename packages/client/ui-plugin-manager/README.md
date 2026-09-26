---
description: "Manage the profile's plugin bundles, their rows, and the plugins' configuration from the Web sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

English | [中文](README.zh.md)

## Summary

Use the **Plugins** entry in the Web sidebar to manage the profile's installed bundles and the official bundles the installation ships switched off. Switch bundles and their rows on and off, install a bundle after the Host has read what the spec names, watch pnpm's output, stop a run, and enable what it added. Uninstalling asks for confirmation. A plugin that registers a configuration page is edited here, on its own page; Settings keeps the read-only inventory.

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

Select **Plugins** in the sidebar. The page reads the inventory and the bundles through `api-remotes` when first opened; a Host without a managed profile shows the page as unavailable. **Official** comes first and lists the bundles the installation ships for switching on — off until switched on, without an uninstall, and tagged **Experimental** for experimental features — followed by the official plugins that registered a configuration page; **Installed** lists the bundles the profile holds. Cards are listed by name, so switching a bundle on or off does not move its card. A dependency without a bundle patch is not a plugin and is not listed unless the profile selects it, in which case it carries a problem tag. Global configuration remains in the Settings **Plugins** section.

Installed bundles and their plugin rows display their own title and description in the current UI language on cards and detail pages. Each field falls back from exported locale `meta` to the accessible `package.json` at that plugin address; the final title is the full package or module name, with no package description when both sources omit it. See [Plugin display metadata](../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) for the author format. Bundle cards, details, and component rows display the image declared by their own `package.json.icon`; absent or undecodable images retain the default artwork. Installation previews still use registry or manifest information.

### Installing a bundle

On first use, when pnpm uses the unconfigured official npm registry and npmmirror is offered, the Host probes both registries in parallel. The first successful HTTPS ping response selects the initial source. The dialog preserves remembered choices, manual selections, explicit manager configuration, and custom or unknown pnpm registries. An install clicked during initial probing waits for that bounded operation; a late result cannot overwrite a manual choice or reopen a closed dialog.

The Host sends GET requests to `https://registry.npmjs.org/-/ping` and `https://registry.npmmirror.com/-/ping` through its normal fetch proxy. A 2xx response wins; redirects and failures do not. The remaining request is cancelled, both response bodies are discarded, and cleanup completes before the result returns. The default deadline is 1500 ms and results, including unavailable results, are cached for five minutes. Configure `registryProbeTimeoutMs` and `registryProbeCacheTtlMs` on `ui-plugin-manager`; `registryProbeEnabled: false` disables probing. If both requests fail or time out, the existing default remains selected. No IP-location service or Session content is involved.

**Add plugin** takes a package name with an optional version, a Git address, a tarball, or an absolute local path; the dialog says a package name is what follows `dsh plugin add` in a README. **Install guide and examples** under the field opens a guide that shows the three common forms with an example each; **Use example** drops one into the field. **Registry** beside it names the registry the install asks first and unfolds the choice: pnpm's own registry, named by the registry it actually names — the official npm registry, the mainland China mirror, or its host — which keeps the neutral default name until the Host reads it, is listed once, and carries its host unless that host is already its name; each mirror the Host configured (`pluginManager.registries`), npmmirror as the mainland China mirror; and a typed http(s) address. The options float over the dialog from the control, so unfolding them never lengthens the card, and the card's content scrolls when the guide makes it taller than the viewport. The initial choice follows the response comparison above; the choice is then remembered in this browser (`localStorage`) and starts the next dialog, and a remembered address the Host no longer offers stays as a typed one and remains the requested address when installation starts before the registry list returns. **Install** first asks the Host to read what the spec names (`pluginManager.inspect`) at the chosen registry: a name the list already shows, a name no registry has, a path without a package, a package without a bundle patch, or a spec pnpm would refuse comes back under the field as one sentence, with the spec kept for editing; when no registry could be reached, the sentence names every one asked. The install then starts at the registry that answered. An accepted spec opens the installing screen, which shows the package's name, one-liner, and version as the Host read them and folds pnpm's command and output behind **Show install details**. A finished install offers **Enable now**, which switches the new bundle on, closes the dialog, and scrolls the list to it; closing instead leaves it installed and off. While the Host moves on to another registry, the installing screen says which registry could not serve the package and which is asked now, and each pnpm run behind the details carries a badge naming its registry. A failed install says what went wrong in one line, as the Host attributed it — no registry could be reached, naming every one asked; the host a GitHub address or a tarball link is fetched from could not be reached, which no registry helps; the package was not found, the disk is full, the profile is not writable, pnpm blocked a build script — with pnpm's output behind the details and **Retry** at hand, and **Change registry** beside it when the Host laid the failure at the registry it asked, which returns to the spec with the registry options open; the Host has already put the profile files back. When pnpm blocked a dependency's install scripts, the failed screen lists the packages whose scripts wait for permission and offers **Allow these scripts and retry** in place of **Retry**; the Host saves the permission in the profile's `pnpm-workspace.yaml`, which a failed run leaves as pnpm wrote it, then runs pnpm again, and the installed screen names what was allowed. A successful installation does not certify that a module can activate.

During preparation and download, **Cancel install** asks the Host to stop the run and waits for confirmation. Loading the bundle cannot be cancelled. Closing with ×, Escape, or the backdrop hides the dialog immediately and requests cancellation when possible. **View installation** reopens the same task with its output; another installation cannot start while its outcome is pending or unconfirmed. Confirmed cancellation returns to the spec and shows a toast; the manifest and lockfile are restored, while downloaded files can remain. A lost installation response triggers a request to recover the result; **Check installation status** and reconnect retry that request. If the Host has no active request, **Installation result unavailable** allows returning to editing after checking the plugin list. A cancellation sent before acceptance waits and retries automatically; a failed cancellation can be retried manually. Hidden tasks report their outcome through toasts without reopening the dialog.

When the Host attributes a network failure or timeout to a GitHub address and offers npmmirror, the dialog says **Cannot access GitHub**, or **GitHub connection timed out** for a timeout, and offers **Use mainland China mirror** or **Cancel**. Choosing the mirror returns to an empty package-name field and remembers the selected registry without starting another installation. When the install already asks npmmirror, whether picked, typed, or named by pnpm's own configuration, the button reads **Try another way** instead and returns to the same empty field with **Install guide and examples** unfolded and the registry unchanged. Other failures retain their existing diagnostics and actions. The mirror supplies registry packages and dependencies, not the GitHub repository itself.

### Switching a bundle

A bundle's page shows its full package name under the title, the spec that installs it elsewhere. A bundle's switch changes its layer selection. A profile with HMR recomposes before the operation completes; one without HMR, and a bundle a higher layer overrides, say so in a toast. A bundle the Host cannot read carries a problem tag and its reason on its page and cannot be switched on; one that provides the management components stays locked. The Host answers with error codes, which the page's dictionary words; pnpm's and the Loader's own diagnostics are shown as they are. The page excludes built-in profile bundles from cards and counts even when the profile holds them as dependencies or the Host reports an error. The Host inventory remains complete; the Settings Plugins section's Plugin list tab inspects their plugins.

### Switching one row of a bundle

A row's switch on the bundle's page calls `pluginManager.setPluginEnabled`, which writes the row's `disabled` override into the profile's `cordis.patch.yml`. The tree recomposes at once on a profile with HMR, so the row's host half unmounts or mounts while the rest of the bundle keeps running, and the page follows the client module graph without reloading. Rows use the shared status marker for their Host fiber phase: pending and disabled are idle, loading and unloading are ongoing, active is done, and failed is error. The switch appears only on a bundle that is on; a row without a live entry, or one the Host will not address through the profile patch, is locked with the Host's reason. A list longer than ten rows gets a filter over localized titles, descriptions, row ids, and module names.

### Configuration pages

A plugin that carries its own configuration renders it on this page rather than in Settings, through three slots the page declares: `plugins.item` (list) for an official plugin, listed in the Official group by its `label`; `plugins.bundle.config` (keyed by the bundle's package name) for a bundle's own configuration, shown on the bundle's page between its description and its rows; and `plugins.row.config` (keyed by `<package name>#<row id>`) for one row's configuration, which gives that row a **Configure** control opening the row's page. The page renders `view: 'page'` for forms with their own save controls. Official plugin cards also render `view: 'summary'` under the title; a row's detail page uses that view only when its package description is absent. Only a save writes: the page draws the title, icon, and crumb, and the entry's form drops its staged edits when the page is left. The four host-plane pages the installation ships — the shell executor, the agent loop, Subagent, and the DeepSeek search provider — come from one companion package each, [ui-settings-shell](../ui-settings-shell/README.md), [ui-settings-agent-loop](../ui-settings-agent-loop/README.md), [ui-settings-subagent](../ui-settings-subagent/README.md), and [ui-settings-web-search](../ui-settings-web-search/README.md), registered while the Host serves their namespaces. A bundle's browser half registers the same way:

```tsx ignore-check
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@acme/dsh-sidebar#sidebar',
  locale: 'acmeSidebar',
}, ({ t, view }) => view === 'summary' ? t('summary') : <SidebarForm t={t} />))
```

The bundle's patch must declare the row under that id, and the registration exists while the bundle is on, so a bundle that is off shows no configure control.

### Detail page extension points

A plugin with something to say about a bundle, a row, or an official plugin it does not own contributes to that object's page through three list slots the page declares: `plugins.detail.actions` for a control at the head of the page, before the page's own switch and uninstall; `plugins.detail.badge` for a tag beside the title, after the version, experimental, and problem tags; and `plugins.detail.section` for a section under the page's own content — after the rows on a bundle's page, after the configuration on a row's or an official plugin's page. Every entry is rendered with the page's `subject`: `{ kind: 'bundle', pkg }`, `{ kind: 'row', pkg, row }`, or `{ kind: 'item', id }`, where `pkg` and `row` carry the name, version, installed and enabled facts, and the row list a contribution decides on. An entry renders null for a subject it has nothing for and draws its own section chrome; the page orders entries by `order`.

```tsx ignore-check
ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
  name: 'plugins.detail.section',
  id: 'acme-health',
  locale: 'acmeHealth',
}, ({ t, subject }) => subject.kind === 'bundle' ? <HealthSection pkg={subject.pkg} t={t} /> : null))
```

A row's page exists only while a `plugins.row.config` entry names the row, so a contribution meant for a row renders on the page that configuration opens.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Package management uses the profile's dependency records: installed bundles can be toggled and removed; installation-owned bundles remain locked. This distinction does not select startup failure policy.

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The Host entry exposes `pluginRegistryProbe.fastest()` through the generated Remote interface. It shares pending comparisons, expires cached results, and aborts and awaits outstanding probes on unload. Calls after unload return a rejected Promise.

The browser plugin registers the `plugins` sidebar entry and its `main` panel through `ctx.slots.inject()`, so both follow late slot declaration, locale changes and teardown. The page is global and belongs to no Session. Display text comes from package metadata and the page's dictionary.

### The store

`PluginManagerController` owns the bundle views, busy keys, notices, install progress and the uninstall confirmation. Each read asks the inventory whether the Host manages a profile, then joins `listBundles` with `listPlugins` into one view per bundle, whose rows carry the live entry's enablement and fiber phase. It coalesces overlapping reads, refreshes after operations, on `plugin-manager/changed`, and on reconnect, and ignores late results after disposal. Install output is grouped by job id. The install dialog moves `idle → checking → starting → running → done | failed`, with `cancelling` and `applying` as the Host reports them and `unconfirmed` when an installation or cancellation response is lost; confirmed `applying` progress never regresses. Recovery uses `waitForInstall`, settling to `unknown` if no active request remains; checking and every active phase use ongoing, while the final screens use done or error. The check runs under an `AbortController` that going back or closing aborts, and its settlement is dropped; a run is stopped only through `pluginManager.cancelInstall`. Closing hides a run without discarding its state. A cancellation that overtakes installation is retried when progress or output acknowledges the request. A change the Host could not apply, a restart it waits for, and an override by a higher layer become toasts that retire on their own.

### Configuration slots

Custom item pages use the Host entry id as their registration id; row pages use the bundle package and row id. The page owner supplies `form.state` and `form.mutate(operations, expectedRevision)` when the entry exposes editable Config fields. A custom page owns its draft and validation display, and may reuse `ConfigField` from ui-primitives. Bundle-wide pages can contain several entries and have no single form.

The page's `main` registration declares `plugins.item`, `plugins.bundle.config`, and `plugins.row.config` as its children, so the slots exist while the page does and a registrant's `ctx.slots.inject` waits for them. `configLedgerSource` projects the three ledgers into one observable — the official items in ledger order with their labels resolved in the active locale, and the bundle and row keys — cached until a ledger or the locale moves; the page binds it as `useConfigLedger` beside the store and never names a configurable plugin itself. The registration-owned navigation store selects the cards, a bundle, an official plugin, or a bundle row; switching away from the Plugins panel resets it to the list, while React remounts preserve the selected target. Other Client plugins inject `pluginNavigation` and call `ctx.pluginNavigation.openBundle(packageName)` to open bundle details without changing the current Session. The target survives the initial inventory load; an absent bundle displays the list. A registration lives with the browser half that made it. `dsh-client-modules` attaches a package's browser half to the Loader row whose specifier is the bare package name, so every page a bundle registers, for itself or for any of its rows, goes away when that row is switched off; a sub-plugin whose page must outlive the other rows ships as its own package. Official packages whose names begin with `@deepseek-ai/dsh-experimental-` display the Experimental marker.

`plugins.bundle.config` supplies bundle detail configuration, keyed by npm package name. `plugins.bundle.activation` offers bundle-owned guidance after explicit enablement from the list, with callbacks to dismiss it or open the bundle details. It does not appear merely because an enabled bundle was listed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the sidebar, the Remote calls, and the Host-side manager.

- [ui-sidebar](../ui-sidebar/README.md) — the panel list the Plugins entry registers into; [ui-layout](../ui-layout/README.md) — the main slot the page occupies.
- [api-remotes](../../api/remotes/README.md) — the Remote BFF surface behind `pluginManager.*` and `pluginInventory.*`.
- [plugin-manager](../../boot/plugin-manager/README.md) — the Host-side manager this page drives.
- [ui-settings-shell](../ui-settings-shell/README.md), [ui-settings-agent-loop](../ui-settings-agent-loop/README.md), [ui-settings-subagent](../ui-settings-subagent/README.md), [ui-settings-web-search](../ui-settings-web-search/README.md) — the official configuration pages that register into this page's `plugins.item` slot.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side management surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Ping response time does not measure package-download throughput. Probes use the Host fetch route, which pnpm-specific proxy settings can differ from; users can always choose the registry manually, and installation retains its existing fallback rules.

<a id="known-limitations-and-deferred-work"></a>


These limits define the reach of the management view; they are current package constraints.

- **Page lifetime** — refreshing the browser loses the tracked request and output. Reconnecting within the same page can recover an active request; completed results are not retained by the Host. Profile file locking serializes installation writes.
- **Only bundles are managed** — a dependency without a bundle patch is refused before it installs; one the profile already holds is left off the page unless the profile selects it, and loading plain plugin modules stays a file operation.
- **Rows show a phase, not a reason** — a failed row reads as failed without the Host's error text; the Host log has it.
- **One install at a time** — the dialog runs one pnpm command; a second spec waits for the first to finish.
- **No version picker** — the spec is typed as pnpm accepts it; the page neither lists registry versions nor offers upgrades.
- **The registry choice is this browser's** — it lives in `localStorage`, so another browser applies its own initial recommendation; the `dsh plugin` command and the agent tool use the Host's configured registry.
- **Every registry read runs pnpm** — opening the dialog, the check, and the install each ask pnpm what its own configuration names; a machine without pnpm reads it as unknown and is offered no fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The panel reads Host-owned facts, and the registry-probe cache stores one comparison result without an independently maintained projection.
