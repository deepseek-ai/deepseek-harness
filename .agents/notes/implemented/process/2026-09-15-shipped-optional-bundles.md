# Agent Note: Ship optional bundles with the installation

Status: implemented

English | [中文](2026-09-15-shipped-optional-bundles.zh.md)

## Problem

The Web plugin page manages only the bundles a person installed into the profile. An official experimental layer such as Agent Teams had to be found on npm and installed by name before it could be switched on, and [default-product isolation](2026-09-12-default-product-experimental-isolation.md) kept every experimental package out of the installation's runtime dependencies, so nothing shipped with dsh could offer it.

## Decision

The launcher names in `OPTIONAL_BUNDLES` (`packages/boot/app-boot/src/profile.ts`, beside the profile templates) the bundles the installation ships for a person to switch on. Each must be a runtime dependency of `apps/cli` that declares `dsh.bundle.patch`, and no shipped profile template selects it. The plugin manager's `listBundles` reports such a bundle as `optional`: switched off until selected, never removable, resolved from the installation like any installation-supplied bundle. The Web plugin page lists optional bundles in a built-in group with an official tag beside the profile's own installed bundles.

Default-product isolation keeps its rules with one declared exception: an optional bundle's dependency graph is outside the default product. The static gate skips the `dependencies` edge from `@deepseek-ai/dsh` to a listed bundle and still rejects a runtime import, a shipped composition, a preset, or a default template that names it, an experimental dependency the list does not name, and a listed name that is not a runtime dependency or not a bundle. The workspace-constraints check accepts the same `dependencies` edges and no other runtime section, and the packed-install release check skips them from the installed entry package while requiring each listed bundle to be installed.

Agent Teams and Auto review ship this way first, as `@deepseek-ai/dsh-experimental-agent-team-profile`, `@deepseek-ai/dsh-experimental-agent-team-web-profile`, and `@deepseek-ai/dsh-experimental-auto-review`.

## Alternatives considered

**A catalog of installable official bundles.** The page would offer names to install from the registry on demand. That keeps the installation unchanged but needs network access at the moment of switching on and a version pin per release.

**A flag on the bundle package.** A `dsh.bundle.optional` declaration would let any published bundle claim a place in the installation; the launcher's own list keeps the choice with the product.

**A list in the installation's manifest.** `dsh.optionalBundles` in `apps/cli/package.json` was the first form; the maintainers keep product decisions in code, where the list is typed, read once, and shared by the manager and the gates.

## Consequences

Optional bundles are downloaded with the product and stay inactive until selected; the runtime isolation smokes still observe no experimental module in a default composition. Switching on an optional Web layer loads its client plugin through the live client module graph. A bundle that needs a companion layer, such as the Agent Teams Web layer over its Host layer, says so in its description; the manager does not select companions automatically.
