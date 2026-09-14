---
description: "Browse Session persistence-type changes across every captured DSH alpha/RC tag and validate the historical snapshots offline."
---

# Persistence changes across DSH prereleases

English | [中文](README.zh.md)

## Summary

This archive provides an approximate historical view of 26 DSH alpha/RC tags and their 25 adjacent transitions. Each release includes a short explanation, source tag, before/after digests, and complete snapshots of changed types for reading and format validation. It does not establish historical runtime compatibility or replace [current-source acknowledgements](../README.md).

## Table of Contents

- [Archived releases](#releases)
- [Files and scope](#files)
- [Extraction and limitations](#extraction)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="releases"></a>
## Archived releases

The [manifest](manifest.json) records every DSH alpha/RC tag captured on 2026-09-12: 16 have release records, and the earliest 10 are tag-only. Entries follow semantic-version order; absent tags are not invented. The first entry establishes the historical starting point, so its change count includes every root.

<!-- persistence-release-index:start -->

| Tag | Source date (UTC) | Session version | Roots / types | Changed roots |
|---|---|---|---|---|
| [dsh-v0.0.1-rc.1](dsh-v0.0.1-rc.1.md) | 2026-08-10 | 0 | 42 / 341 | 42 |
| [dsh-v0.0.1-rc.2](dsh-v0.0.1-rc.2.md) | 2026-08-11 | 0 | 47 / 374 | 45 |
| [dsh-v0.0.1-rc.3](dsh-v0.0.1-rc.3.md) | 2026-08-12 | 0 | 47 / 374 | 12 |
| [dsh-v0.0.1-rc.4](dsh-v0.0.1-rc.4.md) | 2026-08-12 | 0 | 47 / 374 | 0 |
| [dsh-v0.0.1-rc.5](dsh-v0.0.1-rc.5.md) | 2026-08-12 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.1](dsh-v0.1.0-rc.1.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.2](dsh-v0.1.0-rc.2.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.3](dsh-v0.1.0-rc.3.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.5](dsh-v0.1.0-rc.5.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.6](dsh-v0.1.0-rc.6.md) | 2026-08-13 | 0 | 47 / 374 | 0 |
| [dsh-v0.1.0-rc.7](dsh-v0.1.0-rc.7.md) | 2026-08-17 | 0 | 47 / 376 | 1 |
| [dsh-v0.1.0-rc.8](dsh-v0.1.0-rc.8.md) | 2026-08-19 | 0 | 51 / 403 | 8 |
| [dsh-v0.1.1-rc.1](dsh-v0.1.1-rc.1.md) | 2026-08-21 | 0 | 51 / 407 | 1 |
| [dsh-v0.1.1-rc.2](dsh-v0.1.1-rc.2.md) | 2026-08-21 | 0 | 51 / 404 | 10 |
| [dsh-v0.1.2-alpha.1](dsh-v0.1.2-alpha.1.md) | 2026-08-27 | 0 | 54 / 417 | 52 |
| [dsh-v0.1.2-alpha.2](dsh-v0.1.2-alpha.2.md) | 2026-08-30 | 0 | 54 / 417 | 52 |
| [dsh-v0.1.2-alpha.3](dsh-v0.1.2-alpha.3.md) | 2026-08-31 | 0 | 54 / 417 | 0 |
| [dsh-v0.1.2-alpha.4](dsh-v0.1.2-alpha.4.md) | 2026-09-01 | 0 | 54 / 415 | 4 |
| [dsh-v0.1.2-alpha.5](dsh-v0.1.2-alpha.5.md) | 2026-09-02 | 0 | 54 / 415 | 0 |
| [dsh-v0.1.2-rc.1](dsh-v0.1.2-rc.1.md) | 2026-09-03 | 0 | 54 / 415 | 0 |
| [dsh-v0.1.3-alpha.1](dsh-v0.1.3-alpha.1.md) | 2026-09-04 | 2 | 54 / 425 | 17 |
| [dsh-v0.1.3-alpha.2](dsh-v0.1.3-alpha.2.md) | 2026-09-07 | 2 | 56 / 435 | 2 |
| [dsh-v0.1.5-alpha.1](dsh-v0.1.5-alpha.1.md) | 2026-09-08 | 3 | 57 / 443 | 12 |
| [dsh-v0.1.5-alpha.2](dsh-v0.1.5-alpha.2.md) | 2026-09-09 | 3 | 59 / 462 | 4 |
| [dsh-v0.1.5-rc.1](dsh-v0.1.5-rc.1.md) | 2026-09-10 | 3 | 59 / 462 | 0 |
| [dsh-v0.1.5-rc.2](dsh-v0.1.5-rc.2.md) | 2026-09-10 | 3 | 59 / 462 | 0 |

<!-- persistence-release-index:end -->

<a id="files"></a>
## Files and scope

Each tag has an English/Chinese record with `kind: persistence-release`, a pairing sidecar, and `.schema.json`. Its machine declaration contains the tag, immediate predecessor, observed writer version, and each changed root’s before/after digest. The first snapshot contains every root; later snapshots retain only changed roots that remain present and all their reachable types. Deletions use a null after value; unchanged releases retain empty changes and snapshots.

Snapshots cover the logical Session header, physical JSONL header, event envelope, and every first-party event and transitive reference at that tag. Type counts include only definitions reachable after normalization. Historical source references retain file paths without line numbers.

These retrospective records are validated separately from the current acknowledgement chain in the parent directory. Current-rule classifications of old changes are reading aids: historical version 0 did contain structural changes without version increases. A backfilled record cannot authorize a current PR to omit acknowledgement or a required version increase.

<a id="extraction"></a>
## Extraction and limitations

Reconstruction used source at each tag, TypeScript 6.0.3, and the merged [schema extractor](../../../scripts/persistence-schema.ts). The only extraction adaptation omits a redundant `object` member from intersections of early concrete event records. Existing `any` / `unknown` remain opaque; no additional opaque types were substituted for unresolved references. Release schema JSON retains historical identifiers; terminology checks still apply to authored records and current schemas.

The first 22 tags legitimately declare optional `surfaceOp` on surface events. Historical parsing preserves that optionality; current-source parsing still requires the field. Earlier `SessionHeader.version: number` declarations also remain intact, with actual writer version constants recorded separately. A broad `number` declaration cannot supply that constant.

The captured tags use writer versions 0, 2, and 3; no tag uses writer version 1.

Digests describe normalized reconstructed types, not verbatim source text or reproduction of the original toolchain. Summaries provide rough structural context; old applications were not replayed, complete codec behavior was not validated, and migration safety was not proved. An unchanged digest does not establish unchanged behavior.

<a id="verification"></a>
## Verification

All 26 snapshots passed canonical-graph, root-digest, and reachable-type-digest validation. The release-archive check reads only the manifest, records, and snapshots in this tree, without Git, network access, or old-version checkouts; it validates manifest coverage, predecessors, before/after values, snapshot type completeness, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
pnpm run doc-sync
```

The marker-delimited index, inventory cells, and structural-change facts are generated from the snapshots. Default verification rejects stale facts. Run `pnpm run verify-persistence-releases --write` to refresh those regions and pairing records after validating all machine data; authored summaries, source evidence, machine declarations, and schema files are preserved.

Tag completeness is relative to the manifest’s captured scope; offline checks do not discover later tags automatically. Standard documentation checks validate pairing records and Markdown links. The [format template](../../../.agents/skills/dsh-doc/templates/persistence-release.md) defines each record’s fields.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
