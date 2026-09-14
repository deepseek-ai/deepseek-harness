---
description: "Review and maintain recorded Session persistence-type changes, their schema snapshots, and compatibility decisions."
---

# Persistence-type change records

English | [中文](README.zh.md)

## Summary

Use this reference to inspect an acknowledged Session persistence-type change and its predecessor. Each record binds a compatibility decision to exact generated schemas. Local checks compare the current source with the recorded history using only files in the checkout. Start with the [review cookbook](../cookbook/reviewing-persistence-type-changes.md) when changing a persisted type.

For older tagged versions, use the [prerelease archive](releases/README.md). It reconstructs alpha/RC type differences for historical reading and format validation; its observations do not serve as current compatibility acknowledgements.

For complete schemas grouped by Session format, use the [format references](historical-formats/README.md). Their coverage follows the writer constant, including intermediate formats without a release tag.

## Table of Contents

- [Files and ownership](#files-and-ownership)
- [Compatibility rules](#compatibility-rules)
- [History and limitations](#history-and-limitations)
- [Dev Note](#dev-note)

-----

<a id="files-and-ownership"></a>
## Files and ownership

The generated [catalog](../persistence-catalog.md) provides readable declarations and digests; the [schema inventory](../persistence-schema.json) contains the normalized types. Roots cover the logical Session header, the physical JSONL header line, the event envelope, and every repository-declared event. Referenced types contribute transitively to each affected root's digest.

Each dated record has four sibling files:

| File | Owner |
|---|---|
| `YYYY-MM-DD-slug.md` | English acknowledgement with `kind: persistence-change`, one machine declaration, compatibility reasoning, and verification evidence |
| `YYYY-MM-DD-slug.zh.md` | Chinese counterpart with the identical machine declaration |
| `YYYY-MM-DD-slug.i18n.yaml` | Generated bilingual consistency record |
| `YYYY-MM-DD-slug.schema.json` | Generated complete after schemas for the affected roots that remain present |

The [record template](../../.agents/skills/dsh-doc/templates/persistence-change.md) defines the authored format. Record creation accepts a bilingual prose input and generates the machine declaration, snapshots, catalog pair, and consistency records. The verifier reads the machine declaration once from the English file and checks the Chinese declaration for equality. A declaration names each affected root, its predecessor record, its after digest, and its compatibility decision. A new root has no predecessor; a deletion has no after schema and retains an explicit tombstone.

<a id="compatibility-rules"></a>
## Compatibility rules

Every detected structural change requires an acknowledgement. Record creation and update infer the minimum decision from these fixed rules; an explicit `--decision` is a checked assertion. The rules apply to the complete change, so an allowed change cannot hide a simultaneous breaking change.

| Detected change | Minimum decision |
|---|---|
| Add an optional event-body property, including its complete subtree | `same-version` |
| Make a required event-body property optional | `same-version` |
| Add an ordinary event type | `same-version` |
| Make an optional property required, add a required property, change an existing type, or remove/rename a property or event | `version-bump` |
| Change the Session header or event envelope | `version-bump` |

A same-version explanation states why old records can omit the addition and why older readers can ignore it without changing replay. For required-to-optional changes, it explains how readers handle an absent value. The checker validates the type classification; reviewers assess the explanation. A version-bump record includes the increasing header version in the same transition and follows the [Session-format procedure](../cookbook/adding-a-session-format-version.md).

<a id="history-and-limitations"></a>
## History and limitations

One baseline records the complete initial inventory. Later records use their predecessor's after schema as the before schema. The verifier rejects missing predecessors, cycles, duplicate successors for one root, digest mismatches, and current roots that disagree with their latest records. Independent roots can advance independently. Two changes to the same predecessor require a single ordered history after integration.

Accepted records describe historical transitions; preserve their machine declarations and schema snapshots when adding a successor. An unaccepted terminal record can be refreshed explicitly; the command rejects baselines and records with dependants. The tree cannot establish review acceptance. Verification proves consistency within the tree, not that history was never rewritten. No Git ref, remote service, or released checkout supplies the baseline.

Digests describe declared persistence types, not runtime validation or behavior. Comments, source locations, alias names, and harmless declaration reordering do not affect them. Object fields, union alternatives, intersection operands, and index signatures can be reordered when their resolved types stay the same; tuple positions and numeric enum values remain significant. Catalog text and source locations may still change, so regenerate stale artifacts without adding an acknowledgement for an unchanged digest. Opaque types such as `unknown` expose no hidden structure to compare. Behavior-only changes and structures hidden inside opaque values are outside this mechanism's scope. The [decision](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.md) records these trade-offs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
