# Locate documentation and sources

Answer for the running version, and name the files that support each answer.

## Version and this package

All DSH packages of one release share one version. This skill's base directory is `skills/dsh-doc` inside the `@deepseek-ai/dsh-agent-preset` package directory, so `../../package.json` relative to it holds the running version, and `../../README.md` documents the agent presets.

## Source checkout

When the base directory ends in `packages/preset/agent-preset/skills/dsh-doc` and five levels up holds `pnpm-workspace.yaml`, DSH runs from a source checkout rooted there. Read in this order:

1. `docs/user/index.md` and the guides beside it, for user-facing behavior.
2. `packages/<group>/<name>/README.md`, for a package's configuration, extension points, and limitations; `packages/README.md` lists the groups.
3. `packages/<group>/<name>/src/`, when the documentation leaves a question open or a concrete failure needs diagnosis.

## Package directories

With inspection tools, `cordis_inspect_query` `Config.listConfigs` filtered by `name` lists a mounted package's entries, and querying one `entry` returns its `packageDir`. Bundled packages resolve from the dsh installation and profile-installed bundles from the profile. A package directory holds `README.md` and built `lib/` files; read `lib/types/**/*.d.ts` JSDoc when the directory contains it.

## Bounded reads

Read one file at a time with the file-read tool, and use its offset and limit for files longer than a few hundred lines, such as `references/packages.md`. Search with a narrow directory and pattern; do not list or read whole package trees. When the needed file is missing in the installed version, say so instead of answering from another version.
