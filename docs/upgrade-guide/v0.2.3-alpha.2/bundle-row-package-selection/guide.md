---
kind: upgrade-guide
description: "A package installed into a profile no longer replaces the package of a plugin row that a bundle inserts under the same name."
---

# Bundle plugin rows load their bundle's package

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, every plugin row of a profile loaded the nearest package of its name, looked up from the profile directory. A copy installed into `<profile>/node_modules`, directly or as the dependency of another plugin, therefore replaced the package of a row that a bundle such as `@deepseek-ai/dsh-base` inserts. After upgrading, a row that a bundle inserts, including a row of an agent preset the bundle inserts, loads what an import of that bundle loads, when the bundle's `package.json` declares the package under `dependencies` or `optionalDependencies`. When several bundles insert and declare one name, the bundle listed first in `dsh.profile.bundles` decides. A row in the profile's own `cordis.patch.yml` that names the same package loads that package too.

A row whose bundle declares the package under `peerDependencies` or `devDependencies`, or not at all, is unchanged: it loads the copy in `<profile>/node_modules` when one exists, and otherwise the package `dsh` ships. Imports made by installed plugins are unchanged: a plugin still receives the copy it declares.

Three groups are affected. A profile that installed a second copy of a package in order to change what a bundle's row runs no longer gets that copy. A bundle that declares a dependency and keeps it in its own `node_modules`, including a linked development checkout, now runs its row from that copy instead of the copy at the top of the profile or the one `dsh` ships. A bundle that declares a dependency it does not install can no longer load its row from a copy in the profile. A profile where a third-party plugin pinned an old DSH package changes in the other direction: the built-in row is no longer disabled as incompatible.

## Migration

To replace the package of a bundle's row in a profile:

1. Find the row to replace: run `dsh --profile <name> --dump-config` and note its `id`.
2. In `<profile>/cordis.patch.yml`, disable that row and insert a row that names your copy by path. A path selects exactly that file; a package name selects the bundle's package.

   ```yaml
   - id: storage-domain
     disabled: true
   - insert:
       - id: my-storage-domain
         name: ./node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js
   ```

3. Start the profile and confirm that the output lists no `disabling profile plugin row` line for the row and that your plugin's behavior is active.

To keep a bundle's row on the package that `dsh` ships:

1. In the bundle's `package.json`, move the package from `dependencies` to both `peerDependencies` and `devDependencies`.
2. Reinstall the bundle, start the profile, and confirm that the row's behavior comes from the shipped package.
