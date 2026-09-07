# Agent Note: Remove the dedicated repository Plugin path

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-remove-repository-plugin.zh.md)

## Problem

The repository Plugin path duplicated the profile bundle path for installing and composing third-party packages. It added a `.dsh-plugin` manifest, a generated wrapper, a preparation executable, a second Git/package cache, a Loader builtin, and repository-specific Skill and MCP adapters. Profile bundles already install npm or Git package specifications through the profile package manager, retain normal dependency and lifecycle semantics, and contribute an ordered `cordis.patch.yml` layer that can mount ordinary Cordis Plugins.

The duplicate path also exposed less configuration than a bundle. Its `repositories` list selected source strings, but the generated wrapper mounted a code entry without a user-supplied Plugin config. Repository-specific preparation therefore added substantial code and CI work without becoming the general external-Plugin distribution mechanism.

## Decision

DeepSeek Harness has one standalone external-Plugin distribution path: installable profile bundles. `dsh plugin --profile <name> add <package-or-git-spec>` records the dependency in the profile package, and the installed package declares `dsh.bundle.patch` to contribute its patch layer. The package manager owns source acquisition, versions, dependencies, build lifecycles, and its lockfile. The bundle patch owns Cordis Plugin selection and complete Plugin config.

The `@deepseek-ai/dsh-repository-plugin` package, `.dsh-plugin` authoring format, `dsh-plugin-prepare` executable, generated wrapper, immutable repository cache, base `repository-plugins` row, and dedicated GitHub acceptance lane are removed. The unused vendored `@cordisjs/plugin-loader/repository` subpath and its bundled pnpm dependency are removed with their only consumer. Existing repository cache directories are inert user data; DSH neither reads nor deletes them.

Bundles compose existing owners directly. A bundle that contributes Skills mounts `@deepseek-ai/dsh-skill-filesystem`; one that contributes MCP servers mounts `@deepseek-ai/dsh-mcp-client`; native behavior mounts an ordinary compiled Cordis Plugin. These packages retain their own validation, lifecycle, registration, and teardown contracts. No compatibility parser or migration from `.dsh-plugin` is retained under the pre-release compatibility policy.

This note consolidates the removed repository cache, static format, config-only integration, npm-backed preparation, and trusted code-entry decisions. Their original motivation survives here: standalone users need package-manager-owned external composition, Git and npm dependencies may execute trusted lifecycle code, static Skill and MCP contributions should reuse their existing owners, and source identity belongs in the profile dependency specification and lockfile. Their implementation-specific wrappers, cache generations, and preparation protocol no longer constrain the product.

## Alternatives considered

**Keep repository Plugin as a convenience wrapper over bundles.** Rejected because it would preserve two install commands, two manifest formats, and two failure/cache identities for the same package. A convenience that cannot pass ordinary Plugin config also remains less capable than the mechanism it wraps.

**Teach the repository wrapper to load a bundle patch.** Rejected because the repository cache and preparation protocol would still duplicate profile dependency installation. Bundle packages are already accepted from npm, Git, file, and link specifications through pnpm.

**Keep the generic Loader repository cache for possible future consumers.** Rejected because it has no current consumer after the package removal and carries a pinned package-manager runtime in a vendored browser-adjacent package. A dedicated cache is warranted again only if configuration-time activation without an explicit installation becomes a product requirement that profile dependencies cannot satisfy; that consumer can choose its cache contract then.

**Disable repository Plugin but retain its on-disk format for migration.** Rejected under the pre-release stance. Retaining a parser or compatibility loader would keep the removed contract alive without an external compatibility obligation.

## Consequences

- Third-party packages use one installation and composition model, with ordinary dependency declarations and full patch-level Plugin config.
- Installing or updating an external bundle is an explicit `dsh plugin` package-manager operation rather than a watched source-list edit. User patch HMR still configures rows contributed by installed bundles.
- Profile installation requires `pnpm` on the host `PATH`. This is acceptable for an explicit package-management operation and avoids shipping the removed cache's pinned package-manager runtime solely for configuration-time activation.
- `.dsh-plugin` packages and existing repository source-list patches stop working. Their cache files remain removable by the user but are not migrated or automatically deleted.
- The dedicated pnpm runtime, preparation executable, wrapper generator, Git credential CI setup, repository cache, and repository-specific tests disappear.
- Package-relative static assets need a bundle-owned path form so a declarative bundle can point `dsh-skill-filesystem`, `dsh-mcp-client`, or another Plugin at files it ships without custom runtime glue. That capability is owned by the bundle format rather than a repository adapter.

## Testing

Static gates reject stale package, config, documentation, graph, and workspace references. The existing `dsh plugin` built-CLI acceptance covers profile initialization, package-manager installation, bundle discovery, and layer reconciliation. Declarative package-relative Skill and MCP bundle resources remain a named coverage gap in this removal layer.
