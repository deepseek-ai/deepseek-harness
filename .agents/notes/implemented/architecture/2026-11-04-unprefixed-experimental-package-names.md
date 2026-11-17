# Agent Note: Name new experimental packages without the experimental prefix

Status: implemented

English | [中文](2026-11-04-unprefixed-experimental-package-names.zh.md)

## Problem

An experimental package named `@deepseek-ai/dsh-experimental-<name>` must be renamed when it moves to a product group. The rename changes every import, dependency entry, module declaration, and profile file that names the package, so promotion carries a migration that is unrelated to the capability's behavior.

## Decision

New experimental packages use `@deepseek-ai/dsh-<name>` and never the `experimental` prefix. Each one is declared in `EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS` in the [experimental package policy](../../../../scripts/experimental-package-policy.ts), because isolation checks and plugin-record ownership recognize an unprefixed experimental name only through that map. Promotion moves the package and removes its map entry; its npm name stays the same.

Existing packages with the prefix are listed in `LEGACY_PREFIXED_EXPERIMENTAL_PACKAGE_DIRECTORIES`. `pnpm run constraints` rejects the prefix in any other directory and rejects a listed directory that no longer holds a prefixed package, so the list can only shrink. A legacy package is renamed when it is promoted; renaming it earlier needs the release and migration evidence that the [plugin identity decision](2026-10-06-web-desktop-plugin-identity-compatibility.md) requires.

This decision replaces the deferred cleanup that the plugin identity decision recorded, which gave every experimental package the prefix. The [package rules](../../../../packages/experimental/AGENTS.md) state the naming rule for authors.

## Alternatives considered

**Keep the prefix as the default.** The name shows experimental status, but each promotion then renames the package and migrates its consumers and installed profiles.

**Rename the legacy packages now.** One rename removes the legacy list, but it changes published names that existing dependencies and profiles use, without a promotion that needs the change.

**Document the rule without a gate.** A new package copied from a legacy one would keep the prefix with every check passing.

## Consequences

The unprefixed-name map grows with every new experimental package; the legacy list only shrinks. Directory placement and the map, not the npm name, identify an unprefixed package as experimental, and an unprefixed name does not grant admission to the default product.
