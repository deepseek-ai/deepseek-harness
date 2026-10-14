# Agent Note: Preserve Web and Desktop plugin identities across experimental consolidation

Status: implemented

English | [中文](2026-10-06-web-desktop-plugin-identity-compatibility.zh.md)

## Problem

Moving a capability into the experimental directory changes its ownership and support classification. Renaming its published package or an existing configuration row additionally changes how installed profiles refer to that capability. Those identity changes can make a working Web or Desktop customization require edits unrelated to the capability's behavior.

## Decision

The moved packages retain the published names declared by the [experimental naming policy](../../../../scripts/experimental-package-policy.ts). That typed directory-to-name map is the sole maintained inventory of naming exceptions. Package manifests, consumers, installation checks, and bundler checks agree with it; a missing, moved, or duplicated exception is rejected. [Experimental status](../../../../packages/experimental/README.md#status) remains independent of spelling, Official discovery, and explicit selection.

Existing badge, Ralph, and native delegation row IDs remain valid Host row selectors. New isolation groups and newly introduced capabilities retain their new IDs. Later user layers still replace configuration or disable rows. Selecting an optional bundle is still explicit: a patch targeting an absent row does not select its bundle.

Compatibility protection covers Web and Desktop profiles, including existing native provider package identities, selections, configuration, and authentication. Native bundles insert ordinary Host rows, so Headless, SDK, and ACP compositions can select them too; separate provider-only compatibility wrappers are unnecessary. Public APIs remain pre-stable, and new output metadata stays required unless an actual consumer needs an accommodation.

## Deferred naming cleanup

| Retained identity | Unconstrained cleanup | Why it is deferred |
|---|---|---|
| Published names in the naming-exception map | Give every experimental package the `@deepseek-ai/dsh-experimental-` prefix | Existing dependencies, imports, module declarations, and profile files use the established names |
| Existing badge, Ralph, and native-tool row IDs | Give optional contributions consistently distinct `optional-*` selectors | Existing user overrides use those IDs; the ownership move does not require a new selector |

These naming changes are deferred, not prerequisites for experimental classification. A later cleanup requires an explicit release and migration decision, an inventory of affected Web/Desktop configurations, and installed-profile upgrade evidence. Directory moves or pre-stable API status alone do not retire these exceptions. The package list stays in the typed policy rather than being copied into this note or package READMEs.

## Alternatives considered

**Rename every package and row during consolidation.** Uniform spelling makes the new ownership visible, but adds dependency and configuration migration to a change that can preserve those references.

**Publish aliases or keep duplicate compatibility rows.** Parallel identities need continuing resolution and removal rules and can register the same capability twice. Retaining the established identity avoids that additional mechanism.

**Keep provider-only bundles through additional wrapper packages.** Native bundles insert ordinary Host rows that compose into any profile. Extra delivery packages would preserve compositions outside the selected compatibility scope and increase catalog and release maintenance.

## Consequences

The repository carries a bounded naming-exception map and tests that classify retained names through direct imports, aliases, transitive dependencies, and packed or bundled artifacts. An unprefixed name does not grant admission to the default product. Existing row identities have Web/Desktop composition coverage for user overrides and disabled state. No general alias or automatic profile migration mechanism is introduced.

The [classification decision](../process/2026-10-05-product-package-classification.md), [optional-composition decision](2026-09-21-experimental-capabilities-as-optional-bundles.md), and [on-demand discovery decision](2026-10-05-official-on-demand-bundles.md) retain their separate responsibilities. Released Session generations and persisted hook event names remain protected independently of this profile compatibility scope.
