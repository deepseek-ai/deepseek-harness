# Upgrade across DSH releases

DSH upgrade guides describe breaks in DSH surfaces: commands, profile and `cordis.yml` keys, plugin configuration, package exports, services, events, Client slots, and persisted data. A third-party plugin's own changelog is separate; read it from that plugin's package or repository.

When the user asks what an upgrade affects, report the applicable guides and their migration steps. Apply a migration only when the user asks to change files or the profile.

## Choose the guides

1. Target version: the running installation's version from `references/locate-docs.md`, unless the user names another target.
2. Starting version: an exact version from the user, the old installation, a lockfile, or the plugin's history. A manifest range such as `engines.dsh` or a `@deepseek-ai/dsh-*` dependency range only bounds the candidates; never report it as the starting version. Without an exact version, continue with the candidate directories and check each guide against the plugin's code and the target's APIs. Ask only when the migration order or data safety depends on the exact starting version.
3. Affected surfaces: the packages the plugin imports or names in its patch, and the configuration fields, services, events, slots, commands, and stored data it uses.
4. Version directories: `upgrade-guide/v<T>/` describes the upgrade from release vT to the release after it; vT is the release being left, not the target. From vA to a released vB, work through the directories from vA up to, but not including, vB, one adjacent step at a time in release order.
5. Checkouts and prerelease builds: when the target is a checkout or unreleased build whose version is vB, `upgrade-guide/vB/` holds breaks made after vB that the target may already contain; check each such guide against the target's code. Likewise, when the starting point is a checkout or build at vA, check each `vA/` guide against the plugin's code; it may already be applied.

## Find and read them

- Installed DSH: `docs/upgrade-guide/README.md` under the installation directory lists every guide in one `## v<T>` section per version directory, with a summary and English and Chinese paths. The index and its sections can exceed one read, so first print its section headings with their line numbers, then read each chosen section at most 12 lines per call with the file-read tool's offset and limit. With the runtime from `references/locate-docs.md`, in bash, or in PowerShell through its process form with this script and the index path as the argument:

  ```sh
  ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e "require('node:fs').readFileSync(process.argv[1], 'utf8').split(/\r?\n/).forEach((line, index) => { if (line.startsWith('## ')) console.log(index + 1, line) })" "$DSH_INSTALL_DIR/docs/upgrade-guide/README.md"
  ```
  Without that runtime, read the index 12 lines per call from its start.
- Source checkout: the repository has no such index. Read the `description` line at the top of each `docs/upgrade-guide/v<T>/<item>/guide.md` in the chosen directories.

Read only the `guide.md`, or `guide.zh.md` for a Chinese-speaking user, of items that change a surface from step 3. Report the guides used and the ones skipped with the reason. When a needed guide or the documentation directory is missing, say so instead of answering from another version.
