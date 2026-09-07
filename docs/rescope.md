# Vendored package rescope

English | [中文](rescope.zh.md)

The Cordis framework and its foundation libraries are vendored under [`vendor/`](../vendor/README.md) and published under the `@deepseek-ai` scope, because every harness package declares the framework as a peer dependency: publishing the harness publishes this layer with it, and under the upstream names that publication would squat them on the registry. This page is the name mapping; the decision and its consequences live in the [rescope Agent Note](../.agents/notes/archived/process/2026-08-10-vendor-package-rescope.md), and the upstream commits in [`vendor/README.md`](../vendor/README.md).

## Name mapping

| Directory | Upstream name | Published name | Upstream version | Role |
|---|---|---|---|---|
| `vendor/cordis/` | `cordis` | `@deepseek-ai/cordis` | 4.0.0-rc.7 | Framework core: `Context`, `Service`, `Fiber`, events |
| `vendor/cosmokit/` | `cosmokit` | `@deepseek-ai/cosmokit` | 1.8.1 | Shared utilities the framework and Schemastery build on |
| `vendor/schemastery/` | `schemastery` | `@deepseek-ai/schemastery` | 3.18.0 | Config schemas (`Schema`) behind every plugin's `Config` |
| `vendor/loader/` | `@cordisjs/plugin-loader` | `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | `cordis.yml` loading, plugin resolution, repository cache |
| `vendor/include/` | `@cordisjs/plugin-include` | `@deepseek-ai/cordis-plugin-include` | 1.0.4 | Config includes and patch overlays |
| `vendor/group/` | `@cordisjs/plugin-group` | `@deepseek-ai/cordis-plugin-group` | 1.0.0 | Nested plugin groups |
| `vendor/timer/` | `@cordisjs/plugin-timer` | `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | Disposal-aware timers on `ctx` |
| `vendor/hmr/` | `@cordisjs/plugin-hmr` | `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | Hot module replacement for plugins and config |
| `vendor/logger-console/` | `@cordisjs/plugin-logger-console` | `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | Console logger exporter |

Subpath exports keep their path: `@cordisjs/plugin-loader/repository` becomes `@deepseek-ai/cordis-plugin-loader/repository`.

## What the rename does not touch

- **Directory names and upstream source versions.** `vendor/hmr/` stays `vendor/hmr/`, and the table records the upstream version of the pinned source snapshot, so the manifest reads as an upstream snapshot; the vendored `package.json`'s own `version` field is the harness's released manifest version, which `pnpm run release:vendor` bumps and a re-sync restores to the upstream version.
- **Dependency ranges.** A dependency entry changes its key, never its range: `"cordis": "^4.0.0-rc.7"` becomes `"@deepseek-ai/cordis": "^4.0.0-rc.7"`. `linkWorkspacePackages` resolves those preserved ranges to the pinned workspaces.
- **The Loader's `cordis:` builtin prefix.** `cordis:include` and `cordis:group` are a protocol prefix, not a package name.
- **The `cordis.yml` configuration family**, including `*.cordis.yml`, `*.cordis.snapshot.yml`, and `cordis.patch.yml`.
- **Harness packages whose own names contain the word**, such as `@deepseek-ai/dsh-tool-cordis`.
- **Upstream runtime identifiers**, such as Schemastery's `Symbol.for('schemastery')` and its `vendor:` metadata field.
- **Prose outside `docs/`.** `vendor/*/README.md`, package READMEs, and Agent Notes keep the names they were written with; a bare `cordis` there can also be the Python SDK's option name or an agent-preset id. Inside `docs/`, prose and every Markdown fence follow the rename.

## What your code has to change

| Site | Before | After |
|---|---|---|
| Module import | `import { Context } from 'cordis'` | `import { Context } from '@deepseek-ai/cordis'` |
| Typed-event merge | `declare module 'cordis'` | `declare module '@deepseek-ai/cordis'` |
| `package.json` dependency key | `"@cordisjs/plugin-hmr": "^1.0.15"` | `"@deepseek-ai/cordis-plugin-hmr": "^1.0.15"` |
| `cordis.yml` plugin entry | `name: '@cordisjs/plugin-include'` | `name: '@deepseek-ai/cordis-plugin-include'` |

## Applying, verifying, and reverting

[`scripts/rescope-vendor.ts`](../scripts/rescope-vendor.ts) owns the mapping above and performs the rename, so no reference is renamed by hand:

```sh
pnpm run rescope-vendor            # report what would change
pnpm run rescope-vendor --apply    # rewrite every reference
pnpm run rescope-vendor:check      # assert the post-state; runs in the hygiene gate
pnpm run rescope-vendor --apply --reverse   # return to the upstream names
```

Re-apply it after an upstream sync ([procedure](../vendor/README.md)), and follow it with the regeneration it prints: `pnpm install` for the lockfile, `pnpm run gen-third-party-notices`, and `pnpm run verify-translation-pairing --write` for the bilingual pairs it touched.
