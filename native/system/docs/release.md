# Release

Pre-1.0: treat this as a release checklist, not a stability policy.

## Versioning

The native workspace root and every platform/entry package share one version. Run the bump helper from the repository root:

```sh
pnpm --dir native/system release:bump patch          # or minor / major / x.y.z
```

It updates `native/system/package.json` and every `native/system/packages/*` manifest, refreshes the repository root lockfile (`--ignore-scripts --lockfile-only`), and runs `release:verify`. Explicit versions accept full semver including prereleases (`pnpm --dir native/system release:bump 0.0.0-test.0`); the publish workflow puts prerelease versions under the `next` dist-tag, so `latest` never points at a test build. Keep `workspace:*` dependencies in source; pnpm converts them to concrete versions during pack.

Version bumps are normal source changes: open a release PR (or commit) with the launcher manifests and root lockfile, merge it, then create the matching `node-addon-system-vX.Y.Z` tag from that commit. The namespace avoids colliding with release tags for other package families in the repository. The publish workflow validates that the tag matches every launcher package version.

```sh
pnpm --dir native/system release:commit patch        # bump + stage + commit in one command
git tag node-addon-system-v0.0.2
```

## Preflight

```sh
pnpm install --frozen-lockfile
pnpm --dir native/system build:ts
pnpm --dir native/system typecheck
pnpm --dir native/system test:entry
```

On a supported Linux or macOS host, also rehearse the pack path locally:

```sh
pnpm --dir native/system build:native
pnpm --dir native/system build:test-oracle
pnpm --dir native/system test:launcher
pnpm --dir native/system test:flock
pnpm --dir native/system test:packaging
node native/system/scripts/pack-release.mjs native/system/.release/npm --current-platform-only
node native/system/scripts/verify-packed-install.mjs native/system/.release/npm --current-platform-only
```

## Publish

Use the main repository's `Node Addon System Release` workflow so every binary is built on its matching native runner:

1. Run it with `publish=false` (from the release commit) to build all platform binaries, assemble and verify the payloads, pack the tarballs in publish order, rehearse the packed install, and upload the `npm-tarballs` artifact for inspection.
2. Create and push the `node-addon-system-vX.Y.Z` tag matching the package versions.
3. Run the same workflow from that tag with `publish=true`.

The workflow publishes only from the final packed tarballs, in `publish-order.txt` order (platform packages before the entry that optionally depends on them). The current-platform rehearsal uses offline npm installation; the current entry and platform package come from local tarballs. Publishing every platform package before the entry ensures a public entry version never points ahead of its platform packages. The workflow supports npm trusted publishing through GitHub OIDC; without it, provide an `NPM_TOKEN` secret in the `npm-publish` environment. Packages publish with `--access public`.

New scoped package names must be bootstrapped with an `@deepseek-ai` organization token through the `NPM_TOKEN` fallback: npm [requires a package to exist before a trusted publisher can be configured](https://docs.npmjs.com/cli/v11/commands/npm-trust/). After the first release creates the packages, configure each package to trust `node-addon-system-release.yml` in this repository with the `npm-publish` environment, then remove the fallback token when organization policy permits it.

Manual local fallback (current platform's packages only) — always through `pack-release.mjs`, never `pnpm publish` directly (pnpm's pack path strips the launcher's executable bit; see [packaging.md](packaging.md)):

```sh
node native/system/scripts/pack-release.mjs native/system/dist/npm --current-platform-only
node native/system/scripts/verify-packed-install.mjs native/system/dist/npm --current-platform-only
while IFS= read -r tarball; do npm publish "native/system/dist/npm/${tarball}" --access public; done < native/system/dist/npm/publish-order.txt
```

Do not commit `.npmrc` files with tokens or registry overrides.
