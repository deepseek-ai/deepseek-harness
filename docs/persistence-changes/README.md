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

`finalized/vN.json` records the complete root classifications/digests of an accepted compatibility baseline and semantic hashes of its accepted records. The [finalization record](../session-format-status.md#finalization-record) requires its checkpoint. Current V4 schemas may evolve compatibly; the checkpoint protects accepted machine declarations and after schemas even after the writer advances, while excluding prose, aliases, and source locations from record hashes.

A maintainer captures an agreed format with [`createPersistenceFinalizationCheckpoint`](../../scripts/persistence-finalization.ts), writes a new version-named checkpoint without replacing an earlier one, and advances the paired `latestFinalizedVersion`. The helper requires current schemas to match complete acknowledged history. Run the ordinary verifier before committing.

The [record template](../../.agents/skills/dsh-doc/templates/persistence-change.md) defines the authored format. Record creation accepts a bilingual prose input and generates the machine declaration, snapshots, catalog pair, and consistency records. The verifier reads the machine declaration once from the English file and checks the Chinese declaration for equality. A declaration names each affected root, its predecessor record, its after digest, and its compatibility decision. A new root has no predecessor; a deletion has no after schema and retains an explicit tombstone.

<a id="compatibility-rules"></a>
## Compatibility rules

Every detected structural change requires an acknowledgement. Record creation and update infer the minimum decision from these fixed rules; an explicit `--decision` is a checked assertion. The rules apply to the complete change, so an allowed change cannot hide a simultaneous breaking change.

| Detected change | Minimum decision |
|---|---|
| Add an optional event-body property, including its complete subtree | `same-version` |
| Make a required event-body property optional | `same-version` |
| Add an ordinary event type | `same-version` |
| Add a higher numeric `data.version` to an ordinary event while retaining every old payload alternative unchanged | `same-version` |
| Add an explicitly qualified attribution kind to a user/developer source slot whose before and after schemas carry the same supported policy | `same-version` |
| Make an optional property required, add a required property, change an existing type, or remove/rename a property or event | `version-bump` |
| Change the Session header or event envelope | `version-bump` |

A finalized checkpoint protects the accepted baseline without replacing these compatibility rules. At V4, optional additions, ordinary events, and qualified attribution additions can receive new same-version records. Breaking differences require a higher writer version and an acknowledgement containing its own header increase. The accepted V4 record cannot be updated to reuse its original 3→4 transition.

An ordinary event may add payload alternatives with a required, nonnegative integer `data.version` greater than every existing payload version, provided all existing alternatives remain structurally unchanged. The reader must retain support for the old payloads; adding variants at an existing version, dropping old versions, and changing the Session header or envelope remain breaking. Older readers may reject the new payload version. The [catalog acknowledgement](2026-09-20-unknown-child-catalog.md) records one such transition.

The extractor accepts an explicit `@persistenceSource` binding for a core-owned source property on a literal user or developer role; it does not infer a binding from an unannotated type. A producer qualifies its `MessageSourceMap` entry with `@persistenceAttribution`. Qualification promises that an unknown kind and its JSON metadata survive reading without the producer, and that the kind imposes no validation, replay, or authority requirement. A producer may inspect its own kind to resume duplicate suppression; other readers must preserve and derive the recorded messages without that projection. The recorded schema retains the binding, policy version, literal `kind` discriminator, preservation promise, and qualified kind set. Inventory format 2 stores those promises; extraction without a bound policy retains format 1. Session format versions are independent. Both compared snapshots must carry compatible policy state. Existing kind groups still receive ordinary structural comparison; removals, unmarked additions, policy changes, and unrelated breaking changes remain strict. Multiple context-form alternatives with the same wire kind form one group.

A same-version explanation states how old records remain readable and how older readers handle new records. Optional additions explain why older readers can ignore them without changing replay; a new payload version records the older-reader rejection. For required-to-optional changes, it explains how readers handle an absent value. The checker validates the type classification; reviewers assess the explanation. A version-bump record includes the increasing header version in the same transition and follows the [Session-format procedure](../cookbook/adding-a-session-format-version.md).

When a reader rejects a JSON property by name, declare the property as optional `never` and mark it with argument-free `@persistenceReserved`. The extractor retains the forbidden field, so allowing a JSON value later requires an existing-field type change. Required or JSON-valued properties cannot carry this marker. Unmarked optional `never` and `undefined` properties retain their existing omission behavior.

<a id="history-and-limitations"></a>
## History and limitations

One baseline records the complete initial inventory. Later records use their predecessor's after schema as the before schema. The verifier rejects missing predecessors, cycles, duplicate successors for one root, digest mismatches, and current roots that disagree with their latest records. Independent roots can advance independently. Two changes to the same predecessor require a single ordered history after integration.

Accepted records describe historical transitions; preserve their machine declarations and schema snapshots when adding a successor. An unaccepted terminal record can be refreshed explicitly; the command rejects baselines, records with dependants, and checkpoint-locked records before producing artifacts. Verification checks retained checkpoint hashes; it does not prove that the checkpoints and their authority record were never edited together. No Git ref, remote service, or released checkout supplies the baseline.

Digests describe declared persistence types, not runtime validation or behavior. Ordinary comments, source locations, alias names, and harmless declaration reordering do not affect them. Compatibility annotations are recorded policy data and do affect digests. Unannotated version-1 snapshots retain their original normalization, fingerprints, and strict classification; policy-bearing graphs use a separate fingerprint domain. Object fields, union alternatives, intersection operands, and index signatures can be reordered when their resolved types stay the same; tuple positions and numeric enum values remain significant. Catalog text and source locations may still change, so regenerate stale artifacts without adding an acknowledgement for an unchanged digest. Opaque types such as `unknown` expose no hidden structure to compare. Behavior-only changes and structures hidden inside opaque values are outside this mechanism's scope. The [decision](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.md) records these trade-offs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
