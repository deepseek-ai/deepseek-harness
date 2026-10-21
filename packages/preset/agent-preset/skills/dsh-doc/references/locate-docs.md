# Locate documentation and sources

Answer for the running version, and name the files that support each answer. Read files with the file-read tool, which also opens files inside Desktop's `app.asar`, and use its offset and limit for long files such as `references/packages.md`.

## Version

All DSH packages of one release share one version. This skill's base directory is `skills/dsh-doc` inside the `@deepseek-ai/dsh-agent-preset` package directory, so `../../package.json` relative to it holds the running version.

## Documentation

Every shell call of a profile-launched DSH receives `DSH_INSTALL_DIR`, the directory of the `@deepseek-ai/dsh` package; in Desktop it lies inside `app.asar`. Print it with `echo "$DSH_INSTALL_DIR"` in bash or `$env:DSH_INSTALL_DIR` in PowerShell. Its `docs/` holds this version's documentation and the upgrade guides with their index, `docs/upgrade-guide/README.md`.

In a source checkout, `DSH_INSTALL_DIR` is the checkout's `apps/cli` and has no `docs/`. A base directory ending in `packages/preset/agent-preset/skills/dsh-doc` with `pnpm-workspace.yaml` five levels up identifies the checkout root; read its `docs/user/index.md`, `packages/README.md`, `packages/<group>/<name>/`, and `docs/upgrade-guide/`.

When `DSH_INSTALL_DIR` is unset and the base directory does not identify a source checkout, DSH was started without a profile and its documentation cannot be located; say so.

## Package directories

With inspection tools, `cordis_inspect_query` `Config.listConfigs` filtered by `name` lists a mounted package's entries, and querying one `entry` returns its `packageDir`. Otherwise, resolve a package that the installation ships from `DSH_INSTALL_DIR` with the runtime in `DSH_NODE_EXECUTABLE`, the executable running DSH. In Desktop that is the Electron executable, which runs as Node only with `ELECTRON_RUN_AS_NODE=1`; plain Node ignores the setting. In bash:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e "console.log(require('node:path').dirname(require.resolve(process.argv[1] + '/package.json', { paths: [process.env.DSH_INSTALL_DIR] })))" @deepseek-ai/dsh-tool-bash
```

In PowerShell, set `$env:ELECTRON_RUN_AS_NODE = '1'` and run `& $env:DSH_NODE_EXECUTABLE` with the same arguments. When `DSH_NODE_EXECUTABLE` is unset, DSH runs as a single executable; do not substitute a `node` from `PATH`, which cannot open `app.asar`. When neither inspection nor these variables locate a package, report its behavior as unverified instead of guessing a path.

A package directory holds `README.md`, `src/`, and built `lib/`. Read the README first, then the `src/` file that owns the behavior.

## Bounded reads

Read one file at a time. Native utilities such as `ls`, `cat`, glob, and search cannot open `app.asar`; there, list a directory by running the same runtime through the shell with `require('node:fs').readdirSync(dir).slice(0, 200)`. Elsewhere, search only a narrow directory with a specific pattern. Do not list or read whole package trees. When a needed file is missing in the installed version, say so instead of answering from another version.
