---
description: "Manage the profile's plugin bundles, their rows, and the plugins' configuration from the Web sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-manager

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

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

[Ralph loops](../../experimental/ralph-bundle/README.md) and [Session search](../../experimental/session-search/README.md) remain bundled but are hidden from both plugin lists unless the profile enables or separately installs them. Existing selections remain manageable; switching off an installation-carried copy hides it again. Enter either exact package name in **Add plugin**, then choose **Enable now** to use the shipped copy without downloading it again. Sidebar session search is independent.

Select **Plugins** in the sidebar. The information button uses an 11px caption-colored icon in a 20px square hover area, with a 4px gap after the subtitle. It explains that this page configures official plugins and installs or manages other plugins, while **Settings → Built-in plugins** shows the built-in inventory and runtime status. Hover or focus shows the shared tooltip; clicking keeps it open until another click, Escape, Tab, or an outside click. The page reads the inventory and the bundles through `api-remotes` when first opened; a Host without a managed profile shows the page as unavailable. **Built-in plugin settings** lists official configuration pages by their configured order: Subagent, web search, agent loop, then shell. **Experimental plugins** shows the primary optional bundles, with **More** beside its heading opening a separate page of the same title. That page lists the official bundles eligible for display, including those on the main list, with Codex and Claude Code subagents last. Its back button returns to the main list, where **Installed plugins** remains below Experimental plugins. Bundle details return to the list they were opened from. Catalog entries keep their position after installation or removal. **Installed plugins** lists other profile bundles. Installation-carried optional bundles have no uninstall action. Experimental packages retain the **Experimental** marker on both lists. Switching on a bundle that page holds back adds it to the main list in the position that page shows it, and switching it off leaves it on that page alone unless its manifest hides unselected bundles; other bundles keep their place on both. A dependency without a bundle patch is not a plugin and is not listed unless the profile selects it, in which case it carries a problem tag. Global configuration remains in the Settings **Built-in plugins** section.

As available header width decreases, Refresh and Add plugin first become icon-only controls with accessible names and tooltips; the tabs then shrink from their usual minimum width to fit their labels, and the action group wraps only when necessary. The information button follows the subtitle text. The main page header and list share one scroll container. Header controls move with the scroll position until they reach their compact positions; scrolling back follows the same coordinates. The header retains its resting layout height, so moving its controls does not change the list's scroll range. A barely scrolling list can stop before the header is fully compact. The More list's back-and-title row stays fixed, and detail pages scroll their head row with the content. The Installed/Discover tabs use the compact 34px control with a 2px inset around the selection indicator. The subtitle scrolls out of view; with tabs present, the title also scrolls out, and the tabs settle beside Refresh and Add plugin where space permits. On narrow pages, the tabs and icon actions share a row beneath the heading where they fit; otherwise the tabs stay above the actions. Their relative order stays the same throughout scrolling. The resting and compact layouts retain their 28px and 16px page-top insets respectively, with 16px below the compact controls. macOS adds the frame's titlebar clearance while resting; its compact bar keeps 16px above and below with the sidebar expanded, and with the sidebar collapsed it also clears the frame's top strip so the controls stay below the native window controls. Only on macOS, when the sidebar is collapsed, the compact controls keep 8px rather than 16px above them in addition to the unchanged frame clearance, at every width. The resting layout and compact bottom spacing stay unchanged. Windows relies on the frame's caption offset without adding it again. The divider spans the page at the bottom of the compact header; the list's initial top spacing scrolls with its content. Hover styling applies only where the pointer can hover, so a tap leaves no card, row, or menu option in its hover state; cards and icon actions answer a touch-down with the pressed fill instead. The install, registry, and filter fields take a 16px face under a coarse pointer, which keeps iOS Safari from zooming a focused field.

Installed bundles and their plugin rows display their own title and description in the current UI language on cards and detail pages. Each field falls back from exported locale `meta` to the accessible `package.json` of a package-root plugin; subpath plugins never read one; the final title is the full package or module name, with no package description when both sources omit it. See [Plugin display metadata](../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) for the author format. Bundle cards, details, and component rows display the package root's manifest `icon` or exported `./icon`, or a subpath plugin's exported `<subpath>/icon`; absent or undecodable images retain the default artwork. Installation previews still use registry or manifest information.

A bundle's page shows the bundle's detail document first among its sections, without a heading of its own: the bundle's long description in the current UI language, as Markdown with images. It is the Markdown file that `meta.detail` in the bundle's `locale/<language>.json` names, otherwise the bundle's README, read by [`pluginManager.readBundleDetail`](../../boot/plugin-manager/README.md#bundle-detail-documents) in the [document order of `dsh-plugin-detail`](../../util/plugin-detail/README.md#document-order); the repository a bundle declares is not read. An installed bundle's document comes from its own files without network access, and an on-demand Official bundle's from the npm file CDNs at its offered version. While the document loads the section shows three skeleton lines; a bundle without a document shows no section; a failed read names its reason with **Retry**. Raw HTML is omitted, relative images load from the Host beside the document, relative links stay text, and a document taller than the section's height limit scrolls inside it. A bundle whose files are not installed, such as an on-demand Official bundle, is read from the npm file CDNs: its read first asks the Host's registry comparison and, when npmmirror answered fastest, reads it and its images from npmmirror first. An installed bundle's read does not wait for the comparison. Any profile change and a connection reset read shown documents again.

On-demand Official cards are visible offline before installation. Turning one On opens the existing install progress dialog, installs the [target offered by the running Host](../../boot/plugin-manager/README.md#use-this-package), and selects its layer. The same registry fallback, cancellation, and script-approval controls apply. Turning Off keeps the dependency installed; Remove is separate. A different version or development link source offers **Update**; details show current and offered sources and versions. An update removes the installed package and installs the offered one with the same selection, reporting whether a restart is required; when the installation fails after the removal, the package stays uninstalled. Missing or unreadable packages keep their recorded dependency source alongside the diagnostic. An enabled bundle can still be switched Off when its checkout target is unavailable.

The first list read shows a short group-heading placeholder and four skeleton cards, using the real cards' row, icon, and text-line spacing, with the action area left blank. They use the same opacity pulse as Session search and remain static with reduced motion. The accessible loading label and read timing are unchanged; refreshes retain the existing list, and installation and component-loading indicators keep their own states.

The **Refresh** button shows its tooltip after 500 ms of hovering or keyboard focus. It reads the list again, then checks every updatable bundle for newer versions one after another; a failed read checks nothing. During a manual refresh, the button shows a spinner and stays disabled until all pending reads and those checks settle and at least 400 ms have elapsed, preventing a brief spinner flash; repeated refresh requests are ignored and the existing list remains visible. Success shows no toast. With a loaded list, a failed manual refresh keeps the cached content and shows a failure toast, including after leaving Plugins; select the button again to retry. Before any successful list read, failures show an in-place message with **Retry**. Background reads do not show the refresh spinner.

### Installing a bundle

The **Add plugin** control has a main button and a separate arrow for choosing how to add a plugin.

| Button or menu item | Result |
| --- | --- |
| **Add plugin** | Opens the installation dialog with focus in its package field. |
| Arrow: **Choose how to add a plugin** | Opens the menu of installation and plugin-contributed actions. |
| **Install a third-party plugin** | Closes the menu and opens the same dialog for a package name, Git repository, or local directory. |
| **Let the agent create a plugin** | When [ui-agent-preset](../ui-agent-preset/README.md#use-this-package) contributes this item, closes the menu and opens Creator to author a DSH plugin. |

On first use, when pnpm uses the unconfigured official npm registry and npmmirror is offered, the Host probes both registries in parallel. The first successful HTTPS ping response selects the initial source. The dialog preserves remembered choices, manual selections, explicit manager configuration, and custom or unknown pnpm registries. An install clicked during initial probing waits for that bounded operation; a late result cannot overwrite a manual choice or reopen a closed dialog.

The Host sends GET requests to `https://registry.npmjs.org/-/ping` and `https://registry.npmmirror.com/-/ping` through its normal fetch proxy. A 2xx response wins; redirects and failures do not. The remaining request is cancelled, both response bodies are discarded, and cleanup completes before the result returns. The default deadline is 1500 ms and results, including unavailable results, are cached for five minutes. Configure `registryProbeTimeoutMs` and `registryProbeCacheTtlMs` on `ui-plugin-manager`; `registryProbeEnabled: false` disables probing. If both requests fail or time out, the existing default remains selected. No IP-location service or Session content is involved.

**Add plugin** takes a package name with an optional version, a Git address, a tarball, or an absolute local path; the dialog says a package name is what follows `dsh plugin add` in a README. Enter in the package or custom-registry field submits the install request, but Enter used to confirm an input-method candidate does not. **Install guide and examples** under the field opens a guide that shows the package-name example; **Use example** drops it into the field. Typing or pasting the Git or local-path template verbatim still raises the reminder asking for the actual value. A trust box above **Install** stays visible including when the guide is collapsed, and explains that on-demand Official entries offer explicit Update, while other plugins are upgraded by uninstalling and reinstalling. **Registry** beside it names the registry the install asks first and unfolds the choice: pnpm's own registry, named by the registry it actually names — the official npm registry, the mainland China mirror, or its host — which keeps the neutral default name until the Host reads it, is listed once, and carries its host unless that host is already its name; each mirror the Host configured (`pluginManager.registries`), npmmirror as the mainland China mirror; and a typed http(s) address. The options use an opaque selector panel, fill rows only on hover, and show hosts in tertiary text without parentheses. The custom-address area highlights on hover; clicking anywhere in it selects the custom registry and focuses its input, whose focus style matches the package field. Keyboard focus alone preserves the selected registry; activating the custom radio or editing the address selects the custom registry. Tab moves from the selected radio to the address, and Shift+Tab moves back; leaving either end closes the selector and returns focus to **Registry**. Switching to an offered registry retains the custom URL draft for switching back. Submitting an invalid custom address blocks installation, opens the registry selector, and focuses the address. Invalid package and custom-address fields keep a red error border and add the shared blue inset focus ring on focus. The options float over the dialog from the control, so unfolding them never lengthens the card, and the card's content scrolls when the guide makes it taller than the viewport. The initial choice follows the response comparison above; the choice is then remembered in this browser (`localStorage`) and starts the next dialog, and a remembered address the Host no longer offers stays as a typed one and remains the requested address when installation starts before the registry list returns. **Install** first asks the Host to read what the spec names (`pluginManager.inspect`) at the chosen registry: a name the list already shows, a name no registry has, a path without a package, a package without a bundle patch, or a spec pnpm would refuse comes back under the field as one sentence, with the spec kept for editing; when no registry could be reached, the sentence names every one asked. The install then starts at the registry that answered. An accepted spec opens the installing screen, which shows the package's name, one-liner, and version as the Host read them and folds pnpm's command and output behind **Show install details**. Each command line stays on one line and scrolls horizontally; selecting its text includes offscreen arguments. A finished install shows the version pnpm installed; when a run that asked one registry installed another version than the one read, it names both versions, attributes the difference to pnpm's supply-chain security policy (`minimumReleaseAge`), states the risk of a newly published version, and gives the exact `name@version` to install after uninstalling. A finished install offers **Enable now**, which switches the new bundle on, closes the dialog, and scrolls to its card if it is on the current page; closing instead leaves it installed and off. While the Host moves on to another registry, the installing screen says which registry could not serve the package and which is asked now, and each pnpm run behind the details carries a badge naming its registry. A failed install says what went wrong in one line, as the Host attributed it — no registry could be reached, naming every one asked; the host a GitHub address or a tarball link is fetched from could not be reached, which no registry helps; the package was not found, the disk is full, the profile is not writable, pnpm blocked a build script — with pnpm's output behind the details and **Retry** at hand, and **Change registry** beside it when the Host laid the failure at the registry it asked, which returns to the spec with the registry options open; the Host has already put the profile files back. When pnpm blocked a dependency's install scripts, the failed screen lists the packages whose scripts wait for permission and offers **Allow these scripts and retry** in place of **Retry**; the Host saves the permission in the profile's `pnpm-workspace.yaml`, which a failed run leaves as pnpm wrote it, then runs pnpm again, and the installed screen names what was allowed. A successful installation does not certify that a module can activate.

During preparation and download, **Cancel install** asks the Host to stop the run and waits for confirmation. Loading the bundle cannot be cancelled. Closing with ×, Escape, or the backdrop hides the dialog immediately and requests cancellation when possible. **View installation** reopens the same task with its output; another installation cannot start while its outcome is pending or unconfirmed. Confirmed cancellation returns to the spec and shows a toast; the manifest and lockfile are restored, while downloaded files can remain. A lost installation response triggers a request to recover the result; **Check installation status** and reconnect retry that request. If the Host has no active request, **Installation result unavailable** allows returning to editing after checking the plugin list. A cancellation sent before acceptance waits and retries automatically; a failed cancellation can be retried manually. Hidden tasks report their outcome through toasts without reopening the dialog.

When the Host attributes a network failure or timeout to a GitHub address and offers npmmirror, the dialog says **Cannot access GitHub**, or **GitHub connection timed out** for a timeout, and offers **Use mainland China mirror** or **Cancel**. Choosing the mirror returns to an empty package-name field and remembers the selected registry without starting another installation. When the install already asks npmmirror, whether picked, typed, or named by pnpm's own configuration, the button reads **Try another way** instead and returns to the same empty field with **Install guide and examples** unfolded and the registry unchanged. Other failures retain their existing diagnostics and actions. The mirror supplies registry packages and dependencies, not the GitHub repository itself.

### Updating a registry bundle

A third-party bundle installed from a registry, which the Host marks `updatable`, has a **Versions** section on its page below its rows. Opening the page asks the Host for [its newer versions](../../boot/plugin-manager/README.md#use-this-package) once; **Check again** asks again. The section shows one summary row: checking, up to date with the time of the last check, an update to the newest version that declares a bundle, accepts the running DSH, and is neither deprecated nor a prerelease, newer versions that need a DSH update with the DSH peers they need, or a failed check with the registry that failed last and **Retry**. A summary with newer versions unfolds into one row per version, newest first, with its dist-tags, prerelease and deprecated tags, why it cannot be installed, its publication date, and **Update** for an installable version; the installed version closes the list. Below it, the registry that answered is marked **Fallback** when an earlier registry failed, beside the time of the check and **Show prereleases**. A failed check unfolds through **Details** into every registry asked, its role, what it failed with, and pnpm's words. Bundles installed from a link, a path, git, or a tarball, and Official bundles, show no Versions section. Older versions are never offered.

After the checks, the list toolbar says how many plugins can be updated, that all are up to date, or that some checks failed, and cards with an update show **Update available**. The detail head adds **Update to** with the offered version.

**Update** opens a confirmation with the installed and target versions, the registry it installs from, and that a failed installation keeps or reinstalls the installed version. While the Host runs the update the dialog lists the steps it announced and stays open. The outcome says that the new version runs, that it waits for a restart with the Host's reason, that the target was refused before anything changed, that removing the installed version failed, that the target could not be installed while the installed version stayed in place, that the update failed and the previous version was reinstalled, or that the reinstallation failed too and the plugin is not installed; a failed run unfolds pnpm's output. A lost answer says that the result is unknown and the list is read again.

### Switching a bundle

A bundle's page shows its full package name under the title. Its **Source** section, after the rows, names the spec that installs it elsewhere, as `pnpm add` accepts it, or **Built in** for an official bundle the installation ships, then its current version. A bundle's switch changes its layer selection. A displayed detail document stays visible while a profile change triggers a fresh read; the result replaces it when ready. While the Host applies the change, the switch stays disabled and a spinner appears beside it; the action area permanently reserves 22px to the left of the switch. A persistent status region announces the pending change to screen readers. A profile with HMR recomposes before the operation completes; one without HMR, and a bundle a higher layer overrides, say so in a toast. A bundle the Host cannot read carries a problem tag and its reason on its page and cannot be switched on; one that provides the management components stays locked. The Host answers with error codes, which the page's dictionary words; pnpm's and the Loader's own diagnostics are shown as they are. The page excludes built-in profile bundles and the persistent-terminal bundle from cards and detail pages, regardless of activation, dependency declarations, or Host errors. Hiding a bundle preserves its Host availability and activation. The Host inventory remains complete; the Settings Plugins section's Plugin list tab inspects their plugins.

### Switching one row of a bundle

A row's switch on the bundle's page calls `pluginManager.setPluginEnabled`, which records the row's enablement in the profile's `cordis.patch.yml` under the [toggle rules](../../boot/plugin-manager/README.md#use-this-package). The tree recomposes at once on a profile with HMR, so the row's host half unmounts or mounts while the rest of the bundle keeps running, and the page follows the client module graph without reloading. Rows use the shared status marker for their Host fiber phase: pending and disabled are idle, loading and unloading are ongoing, active is done, and failed is error. The switch appears only on a bundle that is on; a row without a live entry, or one the Host will not address through the profile patch, is locked with the Host's reason. A list longer than ten rows gets a filter over localized titles, descriptions, row ids, and module names.

### Configuration pages

A plugin that carries its own configuration renders it on this page rather than in Settings, through three slots the page declares: `plugins.item` (list) for an official plugin, listed in Built-in plugin settings by its `label`; `plugins.bundle.config` (keyed by the bundle's package name) for a bundle's own configuration, shown on the bundle's page between its description and its rows; and `plugins.row.config` (keyed by `<package name>#<row id>`) for one row's configuration, which gives that row a **Configure** control opening the row's page. The page renders `view: 'page'` for forms with their own save controls. Official plugin cards also render `view: 'summary'` under the title; a row's detail page uses that view only when its package description is absent. Only a save writes: the page draws the title, icon, and crumb, and the entry's form drops its staged edits when the page is left. The four host-plane pages the installation ships — the shell executor, the agent loop, Subagent, and the DeepSeek search provider — come from one companion package each, [ui-settings-shell](../ui-settings-shell/README.md), [ui-settings-agent-loop](../ui-settings-agent-loop/README.md), [ui-settings-subagent](../ui-settings-subagent/README.md), and [ui-settings-web-search](../ui-settings-web-search/README.md), registered while the Host serves their namespaces. A bundle's browser half registers the same way:

```tsx ignore-check
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: '@acme/dsh-sidebar#sidebar',
  locale: 'acmeSidebar',
}, ({ t, view }) => view === 'summary' ? t('summary') : <SidebarForm t={t} />))
```

The bundle's patch must declare the row under that id, and the registration exists while the bundle is on, so a bundle that is off shows no configure control.

### Detail page extension points

A plugin with something to say about a bundle, a row, or an official plugin it does not own contributes to that object's page through three list slots the page declares: `plugins.detail.actions` for a control at the head of the page, before the page's own switch and uninstall; `plugins.detail.badge` for a tag beside the title, after the version, experimental, and problem tags; and `plugins.detail.section` for a section under the page's own content — after the source on a bundle's page, after the configuration on a row's or an official plugin's page. Every entry is rendered with the page's `subject`: `{ kind: 'bundle', pkg }`, `{ kind: 'row', pkg, row }`, or `{ kind: 'item', id }`, where `pkg` and `row` carry the name, version, installed and enabled facts, and the row list a contribution decides on. An entry renders null for a subject it has nothing for and draws its own section chrome; the page orders entries by `order`.

```tsx ignore-check
ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
  name: 'plugins.detail.section',
  id: 'acme-health',
  locale: 'acmeHealth',
}, ({ t, subject }) => subject.kind === 'bundle' ? <HealthSection pkg={subject.pkg} t={t} /> : null))
```

A row's page exists only while a `plugins.row.config` entry names the row, so a contribution meant for a row renders on the page that configuration opens.

### Page tabs

Another plugin adds a tab after the page's own **Installed** tab by registering into the `plugins.tab` list slot; the entry's `label` names the tab and `order` places it. The tabs appear under the page header once one entry exists and are hidden on a bundle's, row's, or official plugin's page; the selected tab survives leaving **Plugins**, and a tab whose entry leaves falls back to **Installed**. The page renders the selected entry in place of its groups and hides its own refresh and add buttons there. The owner props carry `install({ spec, registry?, title, version })` and `openPackage(name)`. `install` is for a version the person already confirmed in the tab: the install dialog opens at its check screen, without the spec form, names the plugin with `title` and `version` above the spec, which it shows in smaller monospace text, keeps that name on the progress and result screens, with the installed version once done, asks `registry` first for that install only and never remembers it, and offers **Retry** after a refusal; a hidden installation reopens instead. `openPackage` switches to **Installed** and opens the bundle's page when that tab lists it, and that page's back button returns to the tab that opened it; a bundle the page leaves out, such as a built-in profile bundle, leaves the Installed list open. A confirmed install offers no GitHub mirror recovery, since that recovery reopens the spec form, and its back button cancels a running install. [`ui-plugin-market`](../ui-plugin-market/README.md) contributes the **Discover** tab here.

Access: the Plugins entry, page, refresh notice, Host change subscriptions, and `pluginNavigation` exist only while the current Peer may call `pluginManager/listBundles`; each later grant re-reads a list already loaded, and `pluginChanges` receives no updates while access is withdrawn. The owner always has access.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Package management uses the profile's dependency records: installed bundles can be toggled and removed; installation-owned bundles remain locked. A selected bundle that neither the profile nor the installation holds also offers uninstall, which only removes it from the profile's bundle list. This distinction does not select startup failure policy.

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The Host entry exposes `pluginRegistryProbe.fastest()` through the generated Remote interface. It shares pending comparisons, expires cached results, and aborts and awaits outstanding probes on unload. Calls after unload return a rejected Promise.

The browser plugin registers the `plugins` sidebar entry and its `main` panel through `ctx.slots.inject()`, so both follow late slot declaration, locale changes and teardown. The page is global and belongs to no Session. Display text comes from package metadata and the page's dictionary.

The add control reuses `Button`, `Menu`, and `MenuItemButton`. Both installation actions call the same `openInstall` callback and use `InstallDialog` and `PluginManagerController`. The root-scoped list slot `plugins.add.actions` accepts contributed `MenuItemButton` rows after the install action; each contribution receives an `onDismiss()` callback to close the menu before starting its action.

While the Plugins page has access, other Client plugins can read `pluginNavigation` and call `openList()` to select the Plugins main list, including when a detail page is already open. This browsing action preserves the current Session and opens no installation dialog. Installation remains an explicit action on the Plugins page.

### The store

`PluginManagerController` owns the bundle views, busy keys, notices, install progress and the uninstall confirmation. Each read asks the inventory whether the Host manages a profile, then joins `listBundles` with `listPlugins` into one view per bundle, whose rows carry the live entry's enablement and fiber phase. It coalesces overlapping reads, refreshes after operations, on `plugin-manager/changed`, and on reconnect, and ignores late results after disposal. Install output is grouped by job id. The install dialog moves `idle → checking → starting → running → done | failed`, with `cancelling` and `applying` as the Host reports them and `unconfirmed` when an installation or cancellation response is lost; confirmed `applying` progress never regresses. Recovery uses `waitForInstall`, settling to `unknown` if no active request remains; checking and every active phase use ongoing, while the final screens use done or error. The check runs under an `AbortController` that going back or closing aborts, and its settlement is dropped; a run is stopped only through `pluginManager.cancelInstall`. Closing hides a run without discarding its state. A cancellation that overtakes installation is retried when progress or output acknowledges the request. A change the Host could not apply, a restart it waits for, and an override by a higher layer become toasts that retire on their own.

### Configuration slots

Custom item pages use the Host entry id as their registration id; row pages use the bundle package and row id. The page owner supplies `form.state` and `form.mutate(operations, expectedRevision)` when the entry exposes editable Config fields. A custom page owns its draft and validation display, and may reuse `ConfigField` from ui-primitives. Bundle-wide pages can contain several entries and have no single form.

The page's `main` registration declares `plugins.item`, `plugins.bundle.config`, and `plugins.row.config` as its children, so the slots exist while the page does and a registrant's `ctx.slots.inject` waits for them. `configLedgerSource` projects the three ledgers into one observable — the official items in ledger order with their labels resolved in the active locale, and the bundle and row keys — cached until a ledger or the locale moves; the page binds it as `useConfigLedger` beside the store and never names a configurable plugin itself. The registration-owned navigation store selects the main list, the full experimental plugin list, a bundle, an official plugin, or a bundle row; switching away from the Plugins panel resets it to the list, while React remounts preserve the selected target. A fresh registration starts on the main list. Installation highlighting scrolls to a card only when it is on the current page; it does not change the selected page. Other Client plugins read `pluginNavigation` optionally, through `ctx.get` or `ctx.inject`, and call its `openBundle(packageName)` to open bundle details without changing the current Session; listing it in a plugin's `inject` keeps that plugin pending on a page without access. The target survives the initial inventory load; an absent bundle displays the list. A registration lives with the browser half that made it. `dsh-client-modules` attaches a package's browser half to the Loader row whose specifier is the bare package name, so every page a bundle registers, for itself or for any of its rows, goes away when that row is switched off; a sub-plugin whose page must outlive the other rows ships as its own package. Cards and detail pages show the Experimental marker only for packages in `EXPERIMENTAL_BUNDLES` in [`dsh-official-bundles`](../../util/official-bundles/README.md#plugin-manager-lists); package-name prefixes do not select the marker.

`plugins.bundle.config` supplies bundle detail configuration, keyed by npm package name. Client plugins can subscribe to the read-only `ctx.pluginChanges.bundle(packageName)` source to pause their queries while a bundle or one of its rows is being changed. Notifications precede the management request and continue when the page closes; subscribers release their observation on disposal. `plugins.bundle.activation` offers bundle-owned guidance after explicit enablement from the list, with callbacks to dismiss it or open the bundle details. It does not appear merely because an enabled bundle was listed.

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
- **No version picker** — the spec is typed as pnpm accepts it; the page does not list registry versions. Official on-demand entries offer the [running installation’s target](../../boot/plugin-manager/README.md#use-this-package). Other profile-installed plugins use uninstall and reinstall to change versions; installation-carried bundles upgrade with DSH.
- **The registry choice is this browser's** — it lives in `localStorage`, so another browser applies its own initial recommendation; the `dsh plugin` command and the agent tool use the Host's configured registry.
- **Every registry read runs pnpm** — opening the dialog, the check, and the install each ask pnpm what its own configuration names; a machine without pnpm reads it as unknown and is offered no fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
