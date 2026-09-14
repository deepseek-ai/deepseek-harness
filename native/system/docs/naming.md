# Naming

## npm packages

The public package family belongs to the `@deepseek-ai` scope and uses the `node-addon-system` package prefix; platform packages append platform information only:

```text
@deepseek-ai/node-addon-system
@deepseek-ai/node-addon-system-<platform>
```

Platform suffixes carry OS and CPU. Linux libc variants live inside the same platform package and are declared in `prebuilds.json`.

## Binaries

The Linux launcher remains `bin/landlock-run`. The Node-API addon is `system.node`: `bin/glibc/system.node` and `bin/musl/system.node` on Linux, `bin/system.node` on macOS.

## Environment variables

The `NALR_` prefix (Node Addon Landlock Run) is reserved for build/test orchestration:

```text
NALR_REQUIRE_LANDLOCK   test-only: an unenforcing kernel fails instead of skipping
```

Runtime binaries and entry packages read NO environment variables — a runtime safety rule ([AGENTS.md](../AGENTS.md)), not a naming convention. Do not include the npm scope in environment variable names.

## C symbols

The launcher is a single C file with static linkage; there is no exported symbol namespace. Kernel UAPI constants keep their kernel names prefixed `LL_` where locally defined.
