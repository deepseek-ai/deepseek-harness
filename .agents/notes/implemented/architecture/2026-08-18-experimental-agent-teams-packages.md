# Agent Note: Publish Agent Teams under experimental package names

Status: implemented

English | [中文](2026-08-18-experimental-agent-teams-packages.zh.md)

## Problem

Agent Teams needs the real Session log, subagent lifecycle, tools, examples, snapshots, and repository checks while its service and tool contracts continue to change. Users also need to install the complete Team composition from npm without building a source checkout.

Moving the packages into product-role groups would remove their experimental names and imply stable-package ownership. Publishing every package under `packages/experimental/` would instead expose unrelated internal prototypes. The release policy must let users install Agent Teams while keeping internal-only prototypes private.

## Decision

`packages/experimental/agent-team`, `packages/experimental/tool-agent-team`, `packages/experimental/agent-team-profile`, and `packages/experimental/client-ui-agent-team` are public workspace packages. They retain their existing `@deepseek-ai/dsh-experimental-*` names and join the dsh release family. The [publication denylist decision](../process/2026-09-12-experimental-publication-denylist.md) owns the public default and private exceptions; the [experimental package rules](../../../../packages/experimental/AGENTS.md) own dependency isolation and later promotion.

The dsh pack and publish set and the local baseline publisher include these four Agent Teams directories and the [Cua Driver providers](2026-09-12-computer-use-provider-registration.md). Workspace constraints require them to omit `private`, set `publishConfig.access` to `public`, and keep the experimental npm prefix. Release packages and apps outside the experimental group, plus the Python runtime, cannot name experimental packages in `dependencies`, `optionalDependencies`, or `peerDependencies`; experimental packages may depend on release packages and each other.

The generic caller-reserved continuable child identity and selective direct-child drain remain in the stable Subagent service. They own Subagent identity and Activation lifecycle without importing or naming Agent Teams; the experimental Team service consumes them in the permitted direction.

The [single-bundle decision](2026-09-18-agent-teams-single-bundle.md) supersedes the separate Host and Web bundle composition. This note retains publication, dependency isolation, and promotion rationale. The current Team profile remains opt-in and disables the global continuable-child controls whose model-visible names overlap the Team tools; the [optional-bundle decision](../process/2026-09-15-shipped-optional-bundles.md) owns its inclusion in the installation.

Profile startup resolves selected bundles before computing the [immutable runtime resolution](2026-09-09-profile-resolution-generations.md). The runtime resolution retains installation-first precedence, traverses each explicit bundle root completely in profile order, and keeps pnpm-managed profile packages authoritative. The runtime interception enforces the result in memory without materializing fallback links. A private profile layer can therefore carry experimental plugin rows without adding those plugins to a release app, requiring profile users to install transitive packages directly, weakening packaged-runtime module identity, or changing another profile's resolution.

Experimental status changes compatibility and support expectations, not publication for these four packages. They retain the repository's ordinary documentation, invariant, lifecycle, security, unit, real-composition, and snapshot requirements. Promotion still requires review of the public contracts, limitations, test evidence, runtime dependents, and a named owner accepting stable-package obligations.

## Alternatives considered

**Move Agent Teams into product-role groups.** This would remove the requested experimental npm names and imply stable-package ownership before the contracts have stabilized.

**Keep Agent Teams private and source-checkout only.** This preserves the simplest experimental policy but prevents users from installing the complete opt-in composition from npm.

**Publish every experimental package.** Unrelated prototypes remain internal-only and have not accepted a public package contract.

**Move the Subagent prerequisites into the experimental directory.** Child identity allocation and Activation teardown belong to the Subagent owner and contain no Team-specific contract. Moving or duplicating them would invert the dependency or split one lifecycle across packages.

## Consequences

Agent Teams publishes as four installable tarballs in the dsh release family without changing package names or enabling Team in a shipped profile. Public availability does not make the packages stable or supported by default, and stable release packages cannot take runtime dependencies on them.

The release family carries the experimental npm names. Promotion still creates path and npm-name churn as specified by the experimental package rules.
