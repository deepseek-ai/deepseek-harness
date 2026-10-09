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

Every detected structural change requires an acknowledgement. Keep the Session version when older readers preserve the required meaning of accepted data, safely ignore optional features while retaining opaque records, or refuse unsupported required data before execution, mutation, or recovery truncation. New readers must preserve historical meaning and readability. Bump only when unsafe interpretation cannot be prevented by an effective discriminator. Unknown fields or values count only when existing readers actually handle them safely; type differences alone cannot establish that behavior. See the [reader-compatibility decision](../../.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md).

| Detected change | Recording requirement |
|---|---|
| Add an optional event-body property, including its complete subtree | `same-version` |
| Make a required event-body property optional | `same-version` |
| Add an ordinary event type | `same-version` |
| Add a higher numeric `data.version` to an ordinary event while retaining every old payload alternative under the existing compatibility rules | `same-version` |
| Add an explicitly qualified attribution kind to a user/developer source slot whose before and after schemas carry the same supported policy | `same-version` |
| Make an optional property required, add a required property, change an existing type, or remove/rename a property or event | Compatibility review for `same-version`, or explicit `version-bump` |
| Change the Session header or event envelope | Compatibility review for `same-version`; a header version change requires `version-bump` |

The classifier identifies established same-version cases and changes requiring compatibility review; it cannot decide semantic safety. The latter require an explicit `--decision same-version` when recording or updating without a version increase. The acknowledgement’s Compatibility section explains actual reader behavior in both directions, and Verification records the executed checks. Review the complete transition, including simultaneous changes. An explicit `version-bump` instead requires its own increasing `SessionHeader.version` transition; a same-version decision cannot waive a header version change. Finalized records remain immutable, so a later record cannot reuse the accepted 3→4 transition.

The CLI requires that explicit choice before generating a flagged same-version record. CI reads the recorded `decision: same-version` and accepts it when the ordinary history, schema, and header-version constraints hold, whether the record was generated or edited manually. Verification cannot establish how the record was authored or whether a human reviewed it. Reviewers compare base and head inventories with [`persistence-review`](../cookbook/reviewing-persistence-type-changes.md#generate); `--check` validates current-tree consistency and cannot reveal a transition already covered by an acknowledgement.

An ordinary event may add payload alternatives with a required, nonnegative integer `data.version` greater than every existing payload version, provided every existing alternative remains readable under the established same-version rules above. Optional property additions and required-to-optional changes may accompany the new version; each retained alternative is compared separately. Other payload changes require compatibility review. Older readers may reject the new payload version. The [catalog acknowledgement](2026-09-20-unknown-child-catalog.md) records one such transition.

The extractor accepts an explicit `@persistenceSource` binding for a core-owned source property on a literal user or developer role; it does not infer a binding from an unannotated type. A producer qualifies its `MessageSourceMap` entry with `@persistenceAttribution`. Qualification promises that an unknown kind and its JSON metadata survive reading without the producer, and that the kind imposes no validation, replay, or authority requirement. A producer may inspect its own kind to resume duplicate suppression; other readers must preserve and derive the recorded messages without that projection. The recorded schema retains the binding, policy version, literal `kind` discriminator, preservation promise, and qualified kind set. Inventory format 2 stores those promises; extraction without a bound policy retains format 1. Session format versions are independent. Both compared snapshots must carry compatible policy state. Existing kind groups still receive ordinary structural comparison; removals, unmarked additions, policy changes, and unrelated structural changes require compatibility review. Multiple context-form alternatives with the same wire kind form one group.

Every same-version explanation states how old records remain readable and how older readers handle new records, including established cases that need no explicit CLI decision. A feature absent from a log must retain the old behavior; dispensable features must be safe to ignore; required features need an effective refusal signal. Unsupported-feature refusal must not become corruption recovery or tail truncation. For required-to-optional changes, explain how readers handle an absent value. Reviewers assess behavior and evidence; the checker validates the declaration and type classification. A version-bump record follows the [Session-format procedure](../cookbook/adding-a-session-format-version.md).

When a reader rejects a JSON property by name, declare the property as optional `never` and mark it with argument-free `@persistenceReserved`. The extractor retains the forbidden field, so allowing a JSON value later requires an existing-field type change. Required or JSON-valued properties cannot carry this marker. Unmarked optional `never` and `undefined` properties retain their existing omission behavior.

<a id="history-and-limitations"></a>
## History and limitations

One baseline records the complete initial inventory. Later records use their predecessor's after schema as the before schema. The verifier rejects missing predecessors, cycles, duplicate successors for one root, digest mismatches, and current roots that disagree with their latest records. Independent roots can advance independently. Two changes to the same predecessor require a single ordered history after integration.

Accepted records describe historical transitions; preserve their machine declarations and schema snapshots when adding a successor. An unaccepted terminal record can be refreshed explicitly; the command rejects baselines, records with dependants, and checkpoint-locked records before producing artifacts. Verification checks retained checkpoint hashes; it does not prove that the checkpoints and their authority record were never edited together. No Git ref, remote service, or released checkout supplies the baseline.

Digests describe declared persistence types, not runtime validation or behavior. Ordinary comments, source locations, alias names, and harmless declaration reordering do not affect them. Compatibility annotations are recorded policy data and do affect digests. Unannotated version-1 snapshots retain their original normalization and fingerprints; policy-bearing graphs use a separate fingerprint domain. Object fields, union alternatives, intersection operands, and index signatures can be reordered when their resolved types stay the same; tuple positions and numeric enum values remain significant. Catalog text and source locations may still change, so regenerate stale artifacts without adding an acknowledgement for an unchanged digest. Opaque types such as `unknown` expose no hidden structure to compare. Behavior-only changes and structures hidden inside opaque values are outside this mechanism's scope. The [decision](../../.agents/notes/implemented/process/2026-09-11-persistence-type-history.md) records these trade-offs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
