# Agent Note: Load bundle plugin rows from the packages their bundles select

Status: implemented

English | [中文](2026-11-23-bundle-plugin-rows-load-bundle-selected-packages.zh.md)

## Problem

A profile composes several bundle layers into one root config tree, and the Loader imports every row by name from that tree's single base URL, the profile directory. For a request from inside a profile, the runtime resolution reads the physical copies in the profile directory before the entries of the interception layer ([lookup order](2026-09-19-profile-resolution-lookup-order.md)). A profile is installed with a hoisted layout, so when a third-party plugin pins an old release of a DSH package in its `dependencies`, the old copy lands in `<profile>/node_modules` and the row that `@deepseek-ai/dsh-base` inserts under the same name loads it. The compatibility admission then disables that row, the services that depend on it wait forever, and DSH still starts (#8476).

A request reaches the interception with the row name and the importer, without the bundle that inserted the row. The computation of the resolution has that fact: every bundle layer in `profile.layers` holds its parsed patches and its own package directory, and the layers are ordered.

## Decision

A row that a bundle inserts for a package it declares as its own dependency loads what an import of that bundle loads. `createRuntimeResolution` reads the bundle layers in order and binds each such plugin package name to the first bundle that inserts it. The bindings are stored in the resolution as `bundlePlugins`. At the interception, a request whose importer is the active profile directory itself resolves a bound name again from its bundle, before any other route. Patch reading and application, the Loader, and the existing dependency tables are unchanged.

### Binding

| Input | Source |
|---|---|
| Plugin package name | `ProfileLayer.patches`: the rows a layer inserts, in configuration order, including the rows of inserted groups and the rows an inserted row lists under `config.plugins`; the bare package name of each row name |
| Directory of the bundle that inserts the row | `ProfileLayer.packageDir`, as the layer spells it |
| Packages the bundle declares | `dependencies` and `optionalDependencies` of the `package.json` in that directory |

- The resolution reads the parsed patch lists on the layers. It reads no patch file and applies no patch.
- An agent preset lists its rows under `config.plugins`, so those rows belong to the bundle that inserts the preset. A member of a `plugins` list that is not a row adds nothing, and no other configuration key is read.
- A row is a group when it carries the `group` marker or is named `cordis:group` or `@deepseek-ai/cordis-plugin-group`; the group plugin mounts its array configuration as rows either way.
- A patch that targets a row by id inserts no row. Its `name` asserts the name of the target, and its `config` is not read.
- A row name that is not a bare package name binds nothing: a path, a URL, a builtin, or a value that is not a string.
- The profile's own patch file is not a bundle layer and binds nothing.

The layers are read in `profile.layers` order, which is the `dsh.profile.bundles` order. For each name a layer inserts:

| Case | Result |
|---|---|
| The bundle does not declare the name as a dependency | Not bound by this bundle. A peer, a development dependency, an undeclared package, and the bundle's own name are such names |
| The bundle declares the name, and the name is not bound | The name is bound to this bundle's directory |
| The bundle declares the name, and the name is bound to another bundle | The first binding stays. Bundles that declare the same range are taken to reach the same copy. When the ranges differ and the two bundles reach different real directories, one warning records the name, both bundles, both directories, and both versions; nothing throws |

A dependency declaration states that the bundle chose the copy. A peer declaration states that the host supplies the package, which is how the [publishing guide](../../../../docs/user/develop/basic/publish.md) asks a plugin to declare DSH packages, and a bundle that inserts a Host row without declaring the package makes no statement. For those names the bundle's directory does not say which copy the row uses, so the row keeps the existing lookup.

Binding looks no package up: it reads one manifest for each bundle layer. Only a name that two bundles bind with different declared ranges is resolved from both, to compare their copies. Warnings are recorded on `ProfileRuntimeResolution.bundlePluginWarnings`. Computing a resolution prints nothing; the `dsh` launcher prints them once per start through `reportBundlePluginWarnings`.

### Matching

The config tree requests its rows from the profile directory URL. Loading a row, its compatibility admission, and package metadata queries for it all pass that URL as the importer. An agent preset mounts its rows from the base URL of the config tree that declared it, which is the same URL.

| Importer | Resolves a bound name from its bundle |
|---|---|
| The active profile directory itself | Yes |
| A file or subdirectory inside the profile, including packages in its `node_modules` | No |
| Another profile, a linked directory, or a path outside the profiles tree | No |

- A bound name is routed as a request from the bundle's manifest is: to the entry of the interception layer where that import receives one, and otherwise to Node's own lookup from the bundle. Node keeps `exports`, conditions, subpaths, and error codes. The match precedes local package names and the physical copy in the profile's `node_modules`.
- The importer handed to Node is the real path of the bundle's manifest, read when the row is requested. The [source launcher](2026-07-29-dsh-source-launch-tsx-esm.md) maps a workspace package to its sources only for an importer outside `node_modules`, and a source checkout reaches its bundles through links there.
- A row whose bundle does not reach the package fails to load. The request does not fall back to the lookup of the profile directory.
- A CommonJS request always comes from a file, so it never uses a binding.
- A third-party plugin that imports the package it pins still receives its own copy, next to the copy the row runs.

### Successor generations

A recomputed resolution binds again. `publish()` compares `bundlePlugins` with the other tables, so a successor that differs only in its bindings is published. A binding may be added, dropped, or moved to another bundle without a restart: modules already loaded keep running until their plugin reloads.

## Alternatives considered

**Collect row names where patches are read and hand them to the resolution on the layer.** This changes `loadOverlayPatches`, `parsePatchList`, and `loadProfileDirectory`, and adds a field to `ProfileLayer`. The layers already carry the parsed patches and the bundle directory.

**Resolve each row's package while binding.** Every start would look one package up, take one real path, and read one manifest for each row name, about 720 file-system calls for the `web` profile, and the lookup would have to copy Node's rules. The binding only has to say which bundle a name belongs to; Node resolves the package when the row is requested.

**Record each row's package in `entries`.** An entry occupies its package name at the interception layer for every importer in the profile and yields to physical copies inside the profile. Merged there, either the hoisted old copy still wins, or entries precede physical copies and replace the versions that plugins install for their own imports, which the [lookup order](2026-09-19-profile-resolution-lookup-order.md#alternatives-considered) rejects. `entries` also holds one directory per name, chosen by the first bundle whose dependencies reach it, not by the bundle that inserts the row.

**Use the bindings for every importer.** A third-party plugin's own import would receive the bundle's package, and its pinned dependency would stop applying.

**Use the bindings for every file in the profile outside `node_modules`.** This needs a path test for each importer. Loading a row, its admission, and its metadata queries already share one importer, the profile directory.

**Bind every inserted name that the bundle does not declare as a peer.** A bundle linked from outside the profile that inserts a Host row without declaring the package would resolve the row from its own directory, which does not reach the host's package, and the row would stop loading. A bundle's own name would bind to the bundle itself.

**Bind a declared peer to the package the installation ships.** The binding would read the installation's dependency traversal, and a row would load the installation's package while its bundle's own import receives the nearest physical copy. The case it serves needs a third-party bundle that inserts a row no built-in bundle inserts, declares it as a peer, and shares the profile with a plugin that pins the same package.

**Load the installation's package for every row whose package the installation ships.** A bundle that ships its own copy of such a package and lists it under `dependencies` would run its row from a copy its own imports do not receive.

**Read installation bundles before profile bundles.** The binding would need to tell where each bundle comes from. `dsh.profile.bundles` lists the bundles of the installation first and appends a newly installed bundle, so the layer order gives the same result.

**Let a later layer replace the binding.** A third-party bundle listed last could replace the package of a built-in row by inserting a row of the same name, and #8476 would return in another form.

**Skip the conflicting bundle, or fail the launch.** One pinned dependency would remove every other row of that bundle or stop the whole profile. Keeping the first binding affects only the rows of that name.

**Change the Loader to pass the requesting row to the import.** Each row could then resolve from its own bundle, and two bundles could load different versions of one plugin. It requires changing the vendored Loader.

## Consequences

- A package name has one binding. Two bundles cannot load different versions of one plugin package: every row of that name loads what an import of the first bundle loads.
- A row loads the package its bundle depends on, whatever a third-party plugin hoists into the profile. An incompatible copy in `<profile>/node_modules` no longer disables a built-in row or a row of a built-in agent preset.
- Another copy of a bound package installed into the profile no longer replaces the bundle's row. A row in the profile's own patch file that names a bound package resolves from the bundle too. A row that names a copy by path loads that copy ([upgrade guide](../../../../docs/upgrade-guide/v0.2.3-alpha.2/bundle-row-package-selection/guide.md)).
- A third-party bundle listed before the installation's bundles that inserts and declares a row of the same name binds it. A newly installed bundle is appended to the list, so this needs a hand-edited order.
- A profile bundle that keeps a declared package in its own `node_modules` runs its row from that copy. The existing lookup starts at the profile directory and never reads that copy.
- A name that no bundle declares keeps the existing lookup, which reads a copy that another plugin hoisted into the profile before the package the installation ships. This covers a row whose bundle declares the package as a peer or not at all, a bundle's own row, a row of the profile's own patch file, and a row that a plugin lists under a configuration key other than `config.plugins`.
- A bundle that declares a dependency it does not reach leaves its row unable to load, even where the profile directory reaches a copy.
- A development checkout linked into the profile that declares a host package under `peerDependencies` keeps the existing lookup for its row, as its own imports receive the installation's package. A checkout that lists the package under `dependencies` runs the row from its own copy.
- Each start reads one manifest for every bundle layer. A name that two bundles bind with different declared ranges costs one lookup and one real-path call for each of the two, and two manifest reads when their copies differ.
- Two bundles that declare the same range and still install different copies record no warning.
- A resolution recomputed while the application runs records its warnings without printing them; a user sees them at the next start.
