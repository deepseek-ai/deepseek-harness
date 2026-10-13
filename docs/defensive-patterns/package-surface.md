# Package surface rules

English | [中文](package-surface.zh.md)

Rules for what a package exports, how it is built, and how it declares dependencies. [development.md](../development.md#typescript-project-layout) describes the layout itself; [packages/AGENTS.md](../../packages/AGENTS.md) carries the standing orders.

## A plugin package exports what the Loader loads

A plugin package's entry point takes one of two forms, and they are not mixed. A **function plugin** named-exports `name`, `inject`, `Config`, and `apply`: `name`, `inject`, and `apply` are lower-case, while `Config` is upper-case and appears both as an `interface` and as its Schemastery schema value. A **service plugin** default-exports its service class, which is how the Loader loads it; a default export beside the four makes the Loader discard the function plugin's namespace. Beyond those, a Host entry may export the Service Definition classes and error types that other packages extend or throw — the capability seam consumes exactly those — and never a test-convenience value. The `/client` entry of a UI plugin package is stricter, and [packages/client/AGENTS.md](../../packages/client/AGENTS.md) owns that discipline: a same-package test reaches internals through a relative `../src/...` path or the `./src/*` subpath, so a test-only need never becomes a permanent export. The rule stops a test convenience from freezing into published API.

- The Loader four and its exact form are defined in [cordis-primer.md](../cordis-primer.md#loader-configuration).
- Judged condition: a function plugin's entry (`src/index.ts`) exports an entity beyond the four; a default export is added beside the four, or the two forms are mixed; a `/client` entry exports an implementation value or lets another feature plugin import one; a fixture reaches another package by relative path.
- Boundary: only Loader plugin entry points are constrained. Internal modules, helper functions, and hooks keep exporting values; a Host entry's Service Definition classes and error types are expected exports; and a test fixture stays inside its own package — a relative path into another package's `src` bypasses the `exports` map and the package-boundary checks.
- Exception: none by default; an exception that is genuinely needed requires the domain owner's confirmation.

The compliant entry — the four exports, with the same-package test path recorded as a comment rather than as a fifth export.

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// The plugin entry: the Loader four, and no fifth value
export const name = 'web-app'
export const inject = ['webServer']
export interface Config { /* … */ }
export const Config = z.object({ /* … */ })
export function apply(ctx: Context, config: Config): void { /* … */ }

// A same-package test imports '../src/internal/header.ts' instead of this entry
```

Three ways the entry gains an export it must not have; all three are visible in the diff.

```ts ignore-check
// The entry widened so a test could reach one helper
export { isHeaderLine } from './internal/header.ts'

// Both plugin forms on one entry: the Loader discards the four
export default class WebApp {}

// A fixture reaching into another package by relative path
import { isSurfaceEligibleType } from '../../core/session/src/surface.ts'
```

## Two package shapes, and both are dynamic plugin packages

A new package is either a Host package or a Host + Client package, and both are dynamic plugin packages; no third form is available and there is no exception. The static client libraries the shell seeds through `PLATFORM_MODULES` in [packages/client/web/src/platform.ts](../../packages/client/web/src/platform.ts) — `client-store`, `ui-slots`, `ui-primitives`, `ui-dockkit` — and the zero-dependency libraries under [packages/util/](../../packages/util/) predate this rule and are closed: they keep working as they are, and a new package never joins them. Only a genuine both-face package splits its compiler faces, build output goes to `lib`, and the `include`, `external`, and roster lists are derived by scanning the workspace rather than hand-written. A hand-written list or an invented compiler face makes build output and the manifest disagree, and every later package would have to maintain its own list.

- Judged condition: a new package built as anything but a dynamic plugin package (static-link bundling, a hand-written all-external list); a third `tsconfig` variant; a hand-written `include`, `external`, or roster list.
- Recompute the shapes instead of trusting a number here: list the `tsconfig.json` files under `packages/*/*`, then the packages that also carry `tsconfig.client.json` and `tsconfig.host.json`, then those declaring `dsh.client`.
- Boundary: a both-face package may appear in `include` or `exclude`.
- Exception: none; there is no approval path. A change to a package's shape or compiler faces starts with the owning documents and needs the domain owner's confirmation.
- Owners: [development.md](../development.md#typescript-project-layout) for the compiler faces, [packages/README.md](../../packages/README.md) for the package groups, and [adding-a-package.md](../cookbook/adding-a-package.md) for the steps.

A package in one of the two shapes, with the standard manifest fields and no hand-written external list.

```json
{
  "name": "@deepseek-ai/dsh-example",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }
  }
}
```

A hand-written `external` list — and a `tsconfig.foo.json` invented beside it for one package — leaves the scans nothing to derive, so build output and manifest stop agreeing.

```json
{ "name": "@deepseek-ai/dsh-example", "external": ["@deepseek-ai/*"] }
```

## `package.json` `exports` uses the standard key set

A `package.json` `exports` map uses only the standard key set, in which every key already has one meaning across the repository, and a package never opens a key for its own local purpose. A key that only a handful of packages use without a documenting owner is not a precedent: formalizing a key, including one of the undocumented keys below, means changing the owning document and the check in the same change. The small shared key set is what lets a consumer infer a key's purpose from its name and lets a scan judge the export map at all.

- Standard keys, each with one meaning repo-wide, across `packages/*/*/package.json` and `apps/*/package.json`: `.` (the package entry), `./package.json` (toolchain access, not a semantic export), `./src/*` (source passthrough for tests and tools, whose documented status is still open), `./client` (the browser entry, paired with the `dsh.client` declaration), `./types` (the type entry), `./typert` (the typert type runtime), `./remote` (the `@Remote` call surface), `./locale/*.json` (locale resources), `./cordis.patch.yml` (the bundle patch layer declared by `dsh.bundle`). Counts are not listed here because they rot on the next package; the recompute command below prints them.
- Keys outside that set (`./brand` in 5 packages, `./worker` in 4, `./startup`, `./runner`, and `./protocol` in 2 each, plus many one-off keys) have no documented meaning; they are pending review, not a pattern to copy.
- Judged condition: does a change add an export key outside the standard set?
- Exception: none by default; a new key changes the owning document and the check first, with the domain owner's confirmation.
- Recompute the distribution:

```sh
python3 -c "import json,glob,collections; c=collections.Counter(); [c.update(json.load(open(p)).get('exports',{}).keys()) for p in glob.glob('packages/*/*/package.json')+glob.glob('apps/*/package.json') if isinstance(json.load(open(p)).get('exports'),dict)]; print(c.most_common())"
```

The compliant map — three standard keys used with their repo-wide meanings, in a package that also declares its client entry.

```json
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  }
}
```

Keys opened for one package's local purposes — here `./brand` and `./worker`, whose documented status is pending — turn the export map into a per-package convention that neither a consumer nor a scan can read.

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./brand": "./lib/brand.js",
    "./worker": "./lib/worker.js"
  }
}
```

## Dependency declarations and version consistency are enforced by the dependency scan

Dependency declarations and version consistency are guaranteed mechanically by the dependency scan; this page repeats neither the `devDependencies` and `peerDependencies` field rules nor a package admission list of its own. When the scan fails, reproduce it locally and fix the manifest it names, because the scan and its policy file own the rules. Editing the scan or relaxing its policy so that a change can land is not a normal edit and needs the domain owner's confirmation.

- Entry point: [verify-package-dependencies.ts](../../scripts/verify-package-dependencies.ts), run as `pnpm run verify-package-dependencies`, by `scripts/run-gates.ts` as the `package-dependencies` gate, and directly by `.github/workflows/release.yml`.
- Policy owner: [package-dependency-policy.ts](../../scripts/package-dependency-policy.ts) exports `PACKAGE_DEPENDENCY_POLICY`; the declaration sections, version forms, and exemptions are defined there, with package-level context in [packages/README.md](../../packages/README.md).
- Boundary: this page lists no packages, field rules, or thresholds; it points at the owning file instead.
- Find the wiring: `grep -rn "verify-package-dependencies" package.json .github/workflows scripts/run-gates.ts`.
- Exception: a change to the scan or to the policy requires the domain owner's confirmation and the reason recorded on the change.

The repeatable procedure: reproduce, read the diagnostic, and fix the manifest it names.

```sh
# 1. Reproduce what CI reports
pnpm run verify-package-dependencies

# 2. The diagnostic names the manifest, the section, the dependency, and the expected range
#    packages/example/package.json: dependencies.@deepseek-ai/dsh-base must use workspace:*, found workspace:~

# 3. The fix goes into the manifest, never into the policy file or the scan
#    "dependencies": { "@deepseek-ai/dsh-base": "workspace:*" }

# 4. Re-run the scan until every package matches the published policy
pnpm run verify-package-dependencies
```

Two ways to lose the mechanical guarantee: change the check instead of the manifest, or restate the rule here so that it drifts from its owner.

```text
Relaxing PACKAGE_DEPENDENCY_POLICY, or dropping the scanned section that fails, to go green
Restating a required-devDependency package list or the field rules on this page instead of linking the policy file
```

## Internal dependency syntax follows the package family

Internal dependency syntax follows the package family: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` use `workspace:*`, every other internal package uses `workspace:~`, and `workspace:^` has retired. The same dependency name is written the same way in every workspace, and a mismatch is a hard scan failure rather than a warning a reviewer can waive. The uniform syntax keeps one resolution path and prevents duplicate instances of a dependency and the resolution differences that follow them.

- Judged by `workspaceRange()` in [verify-package-dependencies.ts](../../scripts/verify-package-dependencies.ts): the `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` families get `workspace:*`, every other internal package gets `workspace:~`; the scan walks the managed manifests and compares every declaration of the same dependency name.
- Boundary: a same-namespace package that is not a workspace member declares an ordinary third-party range and is outside the family rule — `@deepseek-ai/libreoffice-kit` is declared `^0.1.5` in `apps/desktop-host/package.json` (dependencies), `packages/bundle/web-app/package.json` (devDependencies), `packages/document/office-to-pdf/package.json` (dependencies), and `packages/skill/skill-office/package.json` (dependencies).
- Distribution is not restated here; the recompute command below prints the current counts of `workspace:*`, `workspace:~`, `workspace:^`, and any exact-range declaration outside the family rule.
- Exception: the scan decides mechanically; a genuine exception means changing the scan and the policy file with the domain owner's confirmation and the reason on the change.
- Recompute:

```sh
python3 -c "import json,glob,collections; c=collections.Counter(); [c.update([r]) for p in glob.glob('apps/*/package.json')+glob.glob('packages/*/*/package.json')+glob.glob('vendor/*/package.json') for s in ('dependencies','devDependencies','optionalDependencies','peerDependencies') for n,r in (json.load(open(p)).get(s) or {}).items() if n.startswith('@deepseek-ai/')]; print(c.most_common())"
```

Each family in its form, with the non-member exception left as an ordinary version range.

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-base": "workspace:*",
    "@deepseek-ai/cordis": "workspace:~",
    "@deepseek-ai/libreoffice-kit": "^0.1.5"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-typert-registry": "workspace:*"
  }
}
```

A `dsh-*` package on `workspace:~` and a workspace member pinned to an external range — each is a hard scan failure, and the retired rule of pinning exact versions is not available as an alternative.

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-base": "workspace:~",
    "@deepseek-ai/cordis": "^4.0.0"
  }
}
```

## A new resolve hook is refused outright

A new `resolve` hook is refused by default — a definite prohibition, not a preference to avoid one. A genuine need has two preconditions together: re-auditing the resolve strategy as a whole rather than patching the specifier that motivated the change, and the domain owner's confirmation before anything lands. An author's own judgment that this case is special is not a confirmation.

- Judged condition: does the change add a `resolve` hook, including a wrapper around an existing hook that rewrites the same specifiers?
- Boundary: this rule decides whether a hook may be added at all; the separation of resolution, hot reload, and plugin management responsibilities is governed separately and does not permit a new hook.
- The one resolution path is the tsx ESM hook registered by the `dsh` source launch, whose rationale is in the [source-launch Agent Note](../../.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md).
- Exception: only the two preconditions above, both recorded on the change.

The compliant path when new resolution behavior is genuinely needed, in order.

```text
A new resolve hook is allowed only after both preconditions hold:

1. Re-audit the resolve strategy as a whole — resolution, hot reload, and plugin
   management responsibilities together, not only the specifier at hand.
2. Record the domain owner's confirmation on the change.
3. Only then add the hook, linking both records from the change.

Until both hold, the answer is no; "this case is special" is the author's judgment,
not a confirmation.
```

A hook added so that one specifier lands where this package expects it, or the equivalent wrapper around the existing hook — the resolution path gains a branch, and what the resolver returns no longer matches `node_modules`.

```ts ignore-check
// Added so one specifier resolves to the local source copy
export async function resolve(specifier: string, parentURL: string, importAttributes: object) {
  if (specifier === '@deepseek-ai/dsh-example') return { url: localSourceUrl, shortCircuit: true }
  return defaultResolve(specifier, parentURL, importAttributes)
}

// The equivalent shape: wrapping the hook that already exists
const previous = hooks.resolve
hooks.resolve = (specifier, context, next) =>
  pinned.has(specifier) ? pinned.get(specifier) : previous(specifier, context, next)
```
