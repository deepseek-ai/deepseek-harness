# Agent Note: Resolve profile modules along the ancestor chain with an interception layer

Status: implemented

English | [中文](2026-09-19-profile-resolution-lookup-order.zh.md)

## Problem

A profile loads plugins from its own package project. The dsh installation packages and the dependencies embedded in bundles are not on the profile's dependency tree, so Node's default `node_modules` lookup starting from the profile cannot find them.

A developer must be able to restate the resolution rule in one sentence: which part is ordinary Node behavior, which part is dsh's intervention, and where that intervention ends. The previous runtime implementation hid the whole `$DSH_HOME/profiles/node_modules` layer for every package name and kept dedicated recognition code for historical directory layouts, so the rule could not be stated in one sentence and nobody could judge whether a given resolution result was expected.

## Decision

Ordinary module requests retain Node's ancestor `node_modules` order. Inside a profile, runtime resolution entries occupy their package positions at `$DSH_HOME/profiles/node_modules`. For an importer in a recorded external linked directory, each candidate `D/node_modules` applies one rule: a name declared in `D/package.json` under `peerDependencies` and present in the runtime resolution uses the runtime package at that position; otherwise Node tries the physical package there. A nearer candidate precedes a peer declaration farther up. Explicit CommonJS `paths` always bypass interception. Node owns the remaining resolution behavior. [Construction, publication, Worker inheritance, and runtime carriers of immutable generations](2026-09-09-profile-resolution-generations.md) are recorded by the existing Note and are not repeated here.

### Part 1: Resolution rules

#### 1. The ancestor chain: Node's ancestor `node_modules` lookup

The importer is the module file that issues the `import` or `require`. Node starts from the importer's directory and searches ancestor `node_modules` positions up to the filesystem root, skipping a redundant `node_modules/node_modules` position. CommonJS also searches `NODE_PATH` and its global directories; ESM does not. The nearest matching candidate wins, subject to Node's package-entry and failure rules.

Symlinks are followed to their real path per Node's default behavior. Once a module is loaded by its real path, the ancestor chain for its subsequent imports is the real path's ancestor chain, regardless of where it was linked from.

The chain below defines the numbering that every table in this Note references. The importer is `$DSH_HOME/profiles/web/node_modules/my-plugin/index.js`:

```text
① $DSH_HOME/profiles/web/node_modules/my-plugin/node_modules
② $DSH_HOME/profiles/web/node_modules
③ $DSH_HOME/profiles/node_modules
④ $DSH_HOME/node_modules
⑤ /node_modules
```

① holds the plugin's private dependencies, ② the packages the profile installed, ③ the interception layer where the runtime resolution occupies the package directories it has entries for, ④ the Harness home, and ⑤ the filesystem root. CommonJS then retains its `NODE_PATH` and global-directory lookup without peer interception at those extra positions.

#### 2. The interception layer: the runtime resolution occupies `$DSH_HOME/profiles/node_modules/<package>`

The interception layer is the first ancestor `node_modules` above the importer's profile directory (`$DSH_HOME/profiles/<name>`). For every profile inside the tree this layer is `$DSH_HOME/profiles/node_modules`.

Every package name in the runtime resolution occupies the package directory position `<interception layer>/<package>` at this layer. For an installation package name such as `@deepseek-ai/dsh-tools`, the package directory at ③ is the copy of the running installation; an old link or old directory of the same name on disk is no longer a member of the chain. For a package name absent from the runtime resolution, the package directory at ③ is the physical content on disk.

The order for one bare package name request: the ancestor chain first walks the layers inside the profile directory (① and ②), and when a candidate exists Node resolves inside that candidate and returns. On reaching ③, if the runtime resolution has an entry for that package name, Node resolves inside the package directory the entry records; a hit returns, and a missing file inside the package continues per Node's own handling of a "found package": CommonJS keeps looking for the subpath layer by layer from ④, ESM fails immediately. If the runtime resolution has no entry, Node looks at the physical directory at ③ and then moves on to ④.

Node remains responsible for `exports`, `imports`, conditions, `main`, subpaths, extensions, caching, and error codes. When the selected package rejects a subpath through `exports`, the error is final; Node does not switch to another package of the same name.

The interception layer reads, writes, and deletes no disk links. Leftover historical symlinks are treated as ordinary filesystem content: the positions of installation package names at ③ are already occupied by the runtime resolution, so old links are never read; all other package names see the contents of ③ normally along the ancestor chain. Profile load removes, once, the projections the link backend of the dsh 0.1.5 releases wrote into a profile: symlinks under the profile's `node_modules` whose target lies inside `<profile>/.dsh-module-fallback/node_modules`, followed by that directory. pnpm-installed packages and every other symlink stay.

#### 3. Linked directories: peer interception at each ancestor position

When `<profile>/node_modules/<package>` links to a real directory R outside the profiles tree, R is a linked root. R need not contain `package.json` or `node_modules`: it may be a package directory, a monorepo package, or a `src` directory. Importers below R follow Node's real ancestor chain. The recorded root decides which importers participate; it does not stop their lookup at R.

Linked interception excludes importers inside installation-scope package directories, using both their configured and real paths. A broad checkout link therefore does not take over the host's own dependency lookup. Overlapping linked roots describe one participation scope: the importer determines the ancestor chain, so neither root order nor link names choose a different peer set.

At each candidate `D/node_modules`, a matching current `D/package.json` peer declaration uses the runtime package if the table supplies that name. This occupies only that package's position, including when `D/node_modules` does not physically exist. Without both a declaration and a runtime entry, Node tries the physical candidate. A missing manifest does not stop lookup. `dependencies` and `devDependencies` do not enable interception, and a peer version range is not an additional resolver filter. The same rule applies to third-party peers such as React when the runtime table supplies them.

A nearer physical candidate wins before any later ancestor peer declaration. If a selected package's `exports` rejects the request, Node's error is final. A legacy CommonJS subpath miss can continue to the next position, where that directory's peer rule applies again; the physical copy at an occupied position is not retried. Each new linked resolution reads the manifests at the positions it visits, without memoizing its selected route. An unreadable manifest supplies no peers; Node retains its native manifest diagnostics. This does not clear Node's caches or automatically reload already loaded modules.

Runtime resolution construction scans top-level and `@scope/*` links in `<profile>/node_modules`. A successor may add or remove linked roots within the existing package-mapping and local-name constraints. Removal needs no restart: a directory no longer covered by any root returns to native lookup for subsequent resolutions. The [generation rules](2026-09-09-profile-resolution-generations.md#immutable-generations) define publication, existing module references, and relink checks across removal. A dependency whose real path lies outside every recorded linked root remains outside interception, even when a plugin links to it.

#### 4. What the interception layer holds: the runtime resolution's scan contents

The runtime resolution is computed once at profile startup and consists of four parts.

- Installation closure: starting from the `package.json` of the currently running dsh package, a breadth-first traversal follows `dependencies` and `peerDependencies`; each edge resolves from the manifest that declares it per Node rules, and the first installed package found owns a package name. The closure holds several hundred entries, roughly half in the `@deepseek-ai/` scope and half third-party libraries. These entries apply to every profile.
- Bundle-only entries: for a bundle selected by the profile that is not part of the closure, the same traversal starts from its manifest, and package names the closure already owns are not overridden. These entries apply only to profiles that select that bundle; they let the Loader import the bundle's embedded plugins by bare name from the profile root.
- Local package names: package names among the profile's direct dependencies that are already installed in `$DSH_HOME/profiles/<name>/node_modules`. They already sit at ② on the ancestor chain; recording them only saves one directory probe.
- Linked roots: top-level and `@scope/*` links in `$DSH_HOME/profiles/<name>/node_modules` whose targets are directories outside both the shared profiles tree and the active profile directory; each records its link name and real directory. Their own manifests are optional. Missing targets and files are excluded. An application-owned profile outside the shared tree does not register its internal pnpm store links as external roots.

The CLI derives the installation anchor from `import.meta.url`, which Node has already resolved to its real path; the Desktop Host builds it from its runtime directory, which is not a symlink. Both leave the installation root equal to its real directory, so bundle discovery and dependency traversal use the same location. During the traversal, every dependency level uses the real directory of its owning package as the lookup anchor for the next level and records the location of the manifest that declares it. After a hit, Node resolves from that declaring location and gets the same result the package's own internal imports get. Every entry records the package name, package directory, version, declaring location, and scope. Declared but uninstalled dependencies are skipped; the bundle package root itself does not become an entry.

#### 5. Hook coverage

The hook participates only when the importer is under `$DSH_HOME/profiles/**` or a linked root. Builtin, relative-path, absolute-path, and URL requests, and every request whose importer is outside both locations, go straight to Node. `require.resolve(request, { paths })` also goes straight to Node, including when a path names a profile or linked directory.

The ESM and CommonJS adapters call the same routing function, and the main thread and Harness-owned Workers install the same runtime resolution. The implementation lives in `packages/boot/app-boot/src/profile-resolution/resolver.ts`; runtime resolution construction lives in `packages/boot/app-boot/src/profile.ts`.

#### 6. Package directories and module files

`packageDir('pkg', parentURL)` and `packageDir('pkg/sub', parentURL)` locate the package directory without loading code or validating the subpath. Ordinary entry and file requests still ask Node to apply `exports`, `main`, conditions, and file existence. A package-directory query can therefore succeed while importing a missing or unexported file fails. `import.meta.resolve` can return a URL for an exported file that does not exist; importing that URL still fails, as in native Node.

### Part 2: Walkthroughs

#### Table 1: Ancestor chain and interception for ESM and CommonJS across request forms

The table uses the installation package `@deepseek-ai/dsh-tools` (has a runtime resolution entry) and the third-party library `left-pad` (no runtime resolution entry) as examples; `pkg` stands for either.

| Request form | ESM | CommonJS | Position of the package name at ③ | When a file is missing inside the package |
|---|---|---|---|---|
| Bare name `pkg`, package has `exports` | If ① or ② has a `pkg` directory, Node takes the entry point from its `exports` | Node selects the require condition from the same candidate | With entry: the runtime resolution's package; without entry: the physical directory | A missing exported target is final |
| Bare name `pkg`, package has no `exports` | Entry point from `main` or `index` | Native legacy entry lookup | As above | ESM fails, final; CommonJS continues only for a native lookup miss, not an invalid declared `main` |
| Subpath `pkg/sub`, package has `exports` | The first `pkg` found decides; if `./sub` is not exported, `ERR_PACKAGE_PATH_NOT_EXPORTED` is final | Same as ESM | As above | Final; no other copy is searched |
| Subpath `pkg/sub`, package has no `exports` | If the first `pkg` found has no `sub`, `ERR_MODULE_NOT_FOUND` is final | Tries `<layer>/pkg/sub` layer by layer: ① and ②, then the position of the package name at ③ (the runtime resolution's package directory when an entry exists), then ④ | As above | ESM final; CommonJS continues to the next layer, that is ④ |
| `#alias` package-internal alias | After the owning manifest's `imports` maps it to a bare name, handled per the rows above; a mapping to a relative path goes straight to Node | Same as ESM, with conditions from the caller or the defaults | Same as the matching row | Same as the matching row |
| `require.resolve(pkg, { paths })` | No such form | Entire request goes to Node with the original options, regardless of the paths' locations | No interception; physical contents only | Native Node continuation and errors |
| Package self-reference (the importer's package imports by its own `name`) | Goes to Node with the original importer kept | Same as ESM | Not involved | Not applicable |
| Relative / absolute / URL / builtin | Goes to Node | Goes to Node | Not involved | Not applicable |

After a runtime resolution hit, the `ERR_MODULE_NOT_FOUND` and `ERR_PACKAGE_PATH_NOT_EXPORTED` errors Node reports replace the internal declaring location with the original importer; the CommonJS require stack also drops the internal anchor.

#### Table 2: Interception position for the Web and Desktop profiles

| profile | Directory | Interception layer | Difference from web |
|---|---|---|---|
| web | `$DSH_HOME/profiles/web` | `$DSH_HOME/profiles/node_modules` | Baseline |
| desktop | `$DSH_HOME/profiles/desktop` | `$DSH_HOME/profiles/node_modules` | None. Same tree, same layer; the Desktop Host runs the same resolver in Node mode |
| Out-of-tree profile | Any directory `loadProfileDirectory` accepts | The first ancestor `node_modules` above that directory | Same rule; no product currently uses an out-of-tree profile, only unit tests cover it |

#### Table 3: Ancestor chain when a plugin is linked outside the tree

The profile links `<profile>/node_modules/my-plugin` to the plugin's real directory R. R's manifest declares `@deepseek-ai/dsh-tools` as a peer and installs it as a devDependency, and declares `zod` as a dependency.

| Import source → target | Hook participates | Result |
|---|---|---|
| profile → linked plugin | Participates up to ② | Node follows the symlink at ②; the plugin loads by its real path |
| Linked plugin → `zod` | Participates; `zod` is not occupied at `R/node_modules` | `R/node_modules/zod`, the developer's installed version |
| Linked plugin → `@deepseek-ai/dsh-tools` (peer) | Participates; the name is occupied at `R/node_modules` | The running dsh's copy; the devDependency copy in `R/node_modules` is not read |
| Linked plugin → a stateful dsh package declared only as a dependency | Participates; the name is not occupied | Its own copy in `R/node_modules`, creating a second instance; the same mistake as installing the dsh package at ② inside the tree. Declare it as a peer instead |
| Linked plugin → undeclared package name | Participates; R does not occupy the name | Physical contents of `R/node_modules`, then the same per-position rule along the real ancestor chain |
| Transitive dependency inside R → any package name | Participates | Each position uses its own manifest's peers; nearer physical candidates precede later peer declarations |
| Link target R has no manifest → peer declared by an ancestor | Participates | Search starts at R; an earlier physical candidate wins, otherwise the ancestor peer can select the runtime package even without physical `node_modules` there |
| Hoisted dependency whose real directory is outside every linked root → any package name | Does not participate | Native Node lookup from that dependency's real directory |
| Installation-scope package inside a broad linked directory → any package name | Does not participate in linked interception | Native lookup retains the host package's own dependencies |
| Any importer → `require.resolve(pkg, { paths })` | Does not participate | Native Node lookup using the supplied paths |

### Part 3: Developer integration guide

#### 1. Normal installation

`dsh plugin --profile <name> add <package | git spec | file:../local-checkout>` forwards its argument to pnpm, which installs inside the profile directory with a hoisted layout. The profile's `pnpm-workspace.yaml` sets `autoInstallPeers: false`, so dsh packages a plugin declares as peers are not installed into the profile; the interception layer supplies the copy from the running installation, and the plugin and dsh share one module instance.

The plugin's own third-party dependencies are hoisted to `$DSH_HOME/profiles/<name>/node_modules` and found at ② on the ancestor chain. When a name collides with the installation closure, the nearest wins and the plugin uses the version it declared. The `file:` form copies the local checkout into the profile; resolution afterwards is identical to a registry installation.

#### 2. Development mode: the plugin repository is outside the profile tree

`npm link`, or a bare directory path such as `dsh plugin add ../my-plugin` (which pnpm treats as `link:`), makes the profile entry a symlink to the plugin repository, which becomes a linked root. The plugin loads by its real path. When lookup reaches its manifest's peer position, the running installation supplies matching runtime entries, whether dsh was installed globally from npm, bundled with Desktop, or started from the source repository. The devDependency copy at that position serves the compiler and is not loaded by an ordinary request. A link to a `src` directory without a manifest can use a parent directory's peers through the same ancestor lookup.

Use the same manifest declarations as the harness packages: declare dsh packages whose instances must be shared with the host under both `peerDependencies` and `devDependencies`. The peer declaration occupies their positions at `R/node_modules`; the dev copies serve the compiler and standalone tests. Keep third-party dependencies and stateless dsh utilities such as `@deepseek-ai/dsh-brand` and `@deepseek-ai/dsh-util-values` under `dependencies`. After changing `peerDependencies`, new resolutions during a plugin reload use the new declaration; Node and Cordis still own the lifetime of already loaded modules.

Two other layouts remain available: install `@deepseek-ai/dsh` in the plugin repository and run `pnpm exec dsh --profile <name>` there, or link dsh packages to a local source repository and start dsh from that repository. Both make the running dsh and the repository's copies identical, but linked plugins do not require either layout.

## Alternatives considered

**Let the runtime resolution act only as a fallback after the whole ancestor chain is exhausted.** The ancestor chain would first read a leftover historical installation link at ③ and use it, which conflicts with "installation packages come from the running installation". The runtime resolution must occupy the positions of installation package names at ③.

**Treat the runtime resolution as a whole layer inserted into the ancestor chain instead of occupying package directories at ③.** The two differ in exactly one place: when CommonJS hits a runtime resolution package and the subpath is missing, the former would go back and read the old copy of the same name at ③, while the latter goes straight to ④ per Node's handling of a "found package". Occupying the package directory matches Node semantics and needs no extra check for ③.

**Give installation closure entries absolute priority over nearer copies.** The closure contains 281 third-party libraries. A plugin's private versions of `zod`, `yaml`, and others would be overridden by the versions in the installation closure, breaking the nearest-wins rule shared with Node. The supported installation flow no longer installs dsh peers into the profile, so overriding is not needed to guarantee a single instance.

**Recognize and bypass symlinks in the `.dsh-module-fallback` layout at resolve time.** This keeps dedicated logic in the lookup path for directories that are no longer produced, and every resolution pays for it. Removing those projections once at profile load reaches the same result: after a bundle is deselected while it stays installed, its projected plugin no longer shadows the same-named plugin the runtime resolution selects from another bundle.

**Hide the whole physical directory that holds the interception layer.** This conflicts with "all other resolution matches Node": non-installation packages placed in `$DSH_HOME/profiles/node_modules` would become invisible to every profile.

**Let every runtime resolution entry occupy its package directory at `R/node_modules`.** This has exactly the same form as ③, but the closure's hundreds of third-party libraries would shadow the plugin repository's own `zod` and `yaml` versions, unlike ① and ② preceding ③ inside the tree. Occupying only peers preserves the plugin's own third-party versions.

**Use the nearest importer's manifest `dependencies` to decide which names resolve natively.** That declaration does not identify a lookup position and cannot describe undeclared packages found at an ancestor. Per-position peer declarations add one eligibility rule without replacing Node's search order.

**Read only the linked root's peers or require its own manifest.** A link can name a `src` directory, and nearer packages and ancestor manifests have their own lookup positions. Fixing interception at R would skip these declarations or override a nearer physical candidate.

**Freeze the peer set during runtime resolution construction.** Every edit to `peerDependencies` would require restarting dsh. Reading at resolution time lets new lookups observe changes, at the cost of reading the visited manifests in development mode. Node's module caches still determine whether an already loaded request needs resolution again.

**Intercept explicit CommonJS paths inside profiles.** An explicit search list is the caller's choice. Passing it unchanged to Node keeps one clear exception instead of making individual items obey different policies.

**Connect the ancestor chain above the linked root back to the profile's ② and ③.** This follows the form of Node's `--preserve-symlinks`: `R/node_modules` remains the first native layer, so the devDependency copy still wins and the duplicate-instance problem remains.

## Verification

- The table-driven matrix in [profile-resolution.spec.ts](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts): importers are the profile root and a plugin inside the profile; package names are an installation entry, a bundle-only entry, and a name outside the table; every presence combination of the four layers ①②③④, with ② and ③ each in two forms, a real directory and a symlink pointing elsewhere; every cell asserts that ESM import, CommonJS require, `require.resolve`, and the `packageDir` metadata land in the same directory.
- Linked-root cases in the same file link a profile package to an external repository with a same-named devDependency copy in its `node_modules`. Package names cover an installation entry declared as a peer, one declared as a dependency, the repository's own third-party dependency, and an undeclared name; importers cover the repository's own files and transitive dependencies inside it. The cases assert agreement across the four resolution forms, that the devDependency copy is not read, and that the next resolution observes a rewritten `peerDependencies` declaration.
- The [differential matrix](../../../../packages/boot/app-boot/tests/linked-resolution-matrix.spec.ts) constructs independent native, intercepted, and reference directories. Only the reference copy replaces eligible peer positions with links to the runtime package; Node resolves the resulting files. Single-package and pnpm monorepo cases compare entry, file, directory, import/require, `import.meta.resolve`, and explicit-path outcomes, including absent manifests, absent `node_modules`, malformed peer declarations, React, outside-scope helpers, and legacy subpath continuation. Assertions compare package selection, existing paths, error codes, and module identity; explicit paths use the pristine native reference.
- Dedicated cases in the same file cover each row of Table 1: bare names and subpaths with and without `exports`, `#alias`, explicit `paths`, package self-reference, CommonJS skipping ③ and going straight to ④ when a subpath is missing after a runtime resolution hit, and the interception position of an out-of-tree profile.
- The [real CLI launch test](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts) covers src and lib launches with ordinary and npm-link layouts, plus a link to a manifest-free `src` directory whose parent declares a peer. It checks shared Tools/AgentLoop instances, native explicit-path selection of the developer's copy, real-path dependency resolution, and unchanged files and link targets. Source-mode CommonJS checks use fixture packages with existing JavaScript entries; real installation CommonJS entries require their build outputs.

## Consequences

Gained: module resolution needs no disk projections; dsh installation packages selected at an interception layer come from the running installation, including peers declared by plugins linked outside the tree; other resolution retains Node's ancestor-chain and package-entry rules; the lookup path does not recognize historical projection directories.

Paid: third-party libraries in the installation closure still occupy package directories at ③; a profile plugin without a nearer copy gets the installation's version. A linked request selects a runtime package only at a matching peer position, and a nearer physical copy still wins. Developers must place declarations and dependencies accordingly. Runtime resolution does not enforce peer version ranges.

Only direct links from `<profile>/node_modules` become linked roots; dependencies whose real directories lie outside every recorded root use native Node. Peer requests do not return to the profile's ②: a name absent from the runtime table must be found on the real ancestor chain. Linked requests pay for current peer-manifest reads. Changing a link target still requires restart; module-cache invalidation and automatic watching are separate from this rule.

Explicit CommonJS paths, plugin-spawned processes, third-party Workers, and external tools do not receive runtime peer mappings. Consumers outside the hook cannot find installation packages through generated disk links. The resolver continues to depend on supported Node Internal interfaces.
