# Agent Note: Bundle the Desktop main process after the workspace tsdown pass

Status: implemented

English | [中文](2026-09-22-desktop-main-bundle-after-workspace-tsdown.zh.md)

## Problem

A macOS Desktop package built from a fresh worktree crashed at launch with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-home-paths' imported from app.asar/lib/main.js`. The packaging log showed why: rolldown had reported `[UNRESOLVED_IMPORT] Could not resolve '@deepseek-ai/dsh-home-paths' … treating it as an external dependency`, and the same for `@deepseek-ai/dsh-app-boot` and `@deepseek-ai/dsh-deepseek-account`. The three packages are workspace devDependencies of `apps/desktop` that the main-process bundle must inline, because electron-builder copies only the manifest's `dependencies` into `app.asar/node_modules`.

The root tsdown config builds every matched workspace member concurrently (`Promise.all` over the resolved configs in tsdown 0.22, with no dependency ordering), and `apps/desktop` was one of those members. Its bundle resolved the three packages through their `exports` to `lib/index.js` files that other concurrent builds had not written yet. On a checkout that had been built before, the stale `lib/` outputs existed and the bundle inlined them, which is why the defect surfaced only on a clean tree; `clean: false` in both configs kept it hidden. The broken bundle was also smaller (189 KB instead of 315 KB) and the packaging run passed every existing check, because the runtime payload smoke exercises the dsh runtime, not the Electron main process.

## Decision

`apps/desktop` leaves the root tsdown `workspace` list. The root `build:lib:host` script runs the Host tsdown pass and then `pnpm --filter @deepseek-ai/dsh-desktop run bundle`, so the main bundle resolves workspace `lib/` outputs that already exist. The package's own `build` script keeps the same `tsc -b` then `bundle` order for local use. A standalone run of the Desktop config produces byte-identical output to the former workspace-mode run: the config was already self-contained, and the root plugins contributed nothing to it.

The Desktop config also asserts the invariant the crash violated. [`desktop-bundle-imports`](../../../../apps/desktop/scripts/desktop-bundle-imports.mjs) is a rolldown plugin on every Desktop bundle whose `moduleParsed` hook fails the build when a module imports a bare specifier the packaged application cannot resolve, whether through a static import, a dynamic `import()`, or a `require()` call: the main bundle may import `electron`, Node builtins, and the manifest's `dependencies`; a sandboxed preload only `electron`, `events`, `timers`, and `url`, the modules Electron's sandbox `require` polyfill resolves. The hook reads each module's import records, where an external import keeps its bare specifier and a bundled one carries an absolute id; chunk metadata (`imports`/`dynamicImports`) omits external `import()` and `require()` targets and cannot serve the check. The check names the actual requirement rather than the symptom, so it also rejects a workspace package moved out of `dependencies` or a broken `exports` entry, and a rejected bundle writes no output.

## Alternatives considered

**Declare the three packages as runtime `dependencies` so electron-builder ships them in the asar.** This is how `@deepseek-ai/cordis` and `@deepseek-ai/dsh-api-gateway` reach the asar today, and it removes the ordering problem. `dsh-app-boot` would bring a large dependency tree into `app.asar/node_modules`, duplicating the copy already inside the packed dsh runtime and enlarging the payload the runtime file policy must screen.

**Fail on rolldown's `UNRESOLVED_IMPORT` warning** through `inputOptions.onLog` or `failOnWarn`. It catches only the unresolved case and would not have covered a dependency misdeclared as a devDependency, which produces a resolved, inlined bundle when the output exists and an external import when it does not. The packaged-imports check covers both with one rule.

**Order the workspace build by dependency graph.** tsdown offers no such ordering, and every other member either inlines nothing from the workspace or externalizes declared `dependencies`, which need no ordering. One extra step for the one package that needs it is smaller than a general scheduler.

## Consequences

A clean checkout, including CI and a fresh worktree, produces the same Desktop main bundle as a long-lived one. A missing or misdeclared runtime import now fails `pnpm run build` and every packaging command with the importing module and the offending specifiers, before signing and notarization spend their time. The Host build gains one sequential step of about a second on a development machine. `docs/development.md` lists the desktop bundle step in the root build order, `scripts/wine-windows-gates.sh` mirrors it, and the [Desktop README](../../../../apps/desktop/README.md#bundled-workspace-dependencies) owns the import rule.
