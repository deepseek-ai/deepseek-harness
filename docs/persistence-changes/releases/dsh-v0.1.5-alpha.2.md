---
description: "Retrospective Session persistence types and adjacent-release changes for dsh-v0.1.5-alpha.2."
kind: persistence-release
---

# Persistence release: dsh-v0.1.5-alpha.2

English | [中文](dsh-v0.1.5-alpha.2.zh.md)

## Summary

deliverables/presented and subagent/catalog are added. Feedback records gain optional category, feedback/record text becomes optional, and the writer format remains 3.

## Table of Contents

- [Release evidence](#evidence)
- [Declaration](#declaration)
- [Structural changes](#changes)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="evidence"></a>
## Release evidence

This approximate backfill supports reading and format validation; it is not a contemporaneous compatibility acknowledgement. See the [archive reference](README.md) for extraction and coverage limits.

| Item | Recorded value |
|---|---|
| Source tag | `dsh-v0.1.5-alpha.2` |
| Source date | 2026-09-09T14:13:03.000Z |
| Release record | Release object present. |
| Previous release | [dsh-v0.1.5-alpha.1](dsh-v0.1.5-alpha.1.md) |
| Session writer version | 3 |
| Reconstructed inventory | <!-- persistence-release-inventory:start -->59 roots / 462 types<!-- persistence-release-inventory:end --> |
| This snapshot | [dsh-v0.1.5-alpha.2.schema.json](dsh-v0.1.5-alpha.2.schema.json) |

Source evidence for the writer version constant at this tag:

- `packages/core/session/src/types.ts`: `export const SESSION_FORMAT_VERSION = 3`

<a id="declaration"></a>
## Declaration

```yaml persistence-release
schemaVersion: 1
tag: dsh-v0.1.5-alpha.2
previous: dsh-v0.1.5-alpha.1
sessionFormatVersion: 3
changes:
  - root: event:deliverables/presented
    before: null
    after: 13d3d180f977bf78081d487ffa0ecb75857349bcab29a5a3fb48189fca2a6176
  - root: event:feedback/message-put
    before: 3b04fde0dc763cf84fbde7b6611b3194dd56d95d0c0bf0204311640468d586e1
    after: b5086d249e8502e9ead1d39156bb8d559bde7951cac0f14ce150345b4e42a2bf
  - root: event:feedback/record
    before: fb9df8180a202f3c845d5aa6a81697b2f7213f6735abc17535a55656be60a575
    after: b54940ff095c17e874c5be03815f4c2145a256cf3a1d34dae4ab2f7769dfffe8
  - root: event:subagent/catalog
    before: null
    after: ae1f7110feeec697b8cab42b68f7709aa7b3279764099dfb53c25890d2e5c871
```

<a id="changes"></a>
## Structural changes

<!-- persistence-release-changes:start -->

Detected 4 changed roots and 5 structural differences. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.

| Path | Change | Current minimum |
|---|---|---|
| `event:deliverables/presented` | `root-added` | `same-version` |
| `event:feedback/message-put.data.item.category` | `optional-property-added` | `same-version` |
| `event:feedback/record.data.text` | `property-made-optional` | `same-version` |
| `event:feedback/record.data.category` | `optional-property-added` | `same-version` |
| `event:subagent/catalog` | `root-added` | `same-version` |

<!-- persistence-release-changes:end -->

<a id="verification"></a>
## Verification

Extraction passed canonical-graph, root-digest, and reachable-type-digest validation, permitting the original optional `surfaceOp` only for historical surface events. The in-tree check reconstructs each tag from its predecessor and verifies before/after values, snapshot coverage, and bilingual machine declarations.

```sh
pnpm run verify-persistence-releases
```

<a id="dev-note"></a>
## Dev Note

None.
