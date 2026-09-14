# Template: persistence-change

Use this template for `docs/persistence-changes/YYYY-MM-DD-slug.md` and its Chinese sibling. The folder README is an index, not a record. A record acknowledges only mechanically detected persistence-type changes. Its generated JSON sibling retains complete after schemas so verification needs no Git baseline.

## Frontmatter

```yaml
---
description: "The persisted types changed and the compatibility decision this record explains."
kind: persistence-change
---
```

## Skeleton

The generator fills the machine declaration, schema companion, and consistency records, inferring the minimum version decision from the fixed rules. Supply `--prose` JSON with `en` and `zh` objects, each containing authored `summary`, `compatibility`, and `verification` strings; the [cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) shows the complete operation. The following values illustrate the document fields; use the actual generated root names, record ids, and digests.

````markdown
# Persistence change: <specific persisted change>

English | [中文](YYYY-MM-DD-slug.zh.md)

## Summary

Describe the mechanically detected change and its version decision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: YYYY-MM-DD-slug
baseline: false
changes:
  - root: event:example/message
    previous: YYYY-MM-DD-predecessor
    after: <generated-64-character-sha256-hex>
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Explain the declared decision for the detected paths. For an optional addition, explain why existing records can omit it and older readers can ignore it without changing replay. For required-to-optional changes, explain how readers handle absence. For a version bump, link the adjacent migration and its verification owner.

<a id="verification"></a>
## Verification

Record the commands actually run and their outcomes. Link focused tests or preserved evidence that support the compatibility explanation.

<a id="dev-note"></a>
## Dev Note

None.
````

## Rules

- Keep exactly one `yaml persistence-change` block. The English and Chinese blocks are byte-identical; the verifier parses the English record once and checks its counterpart.
- The filename stem and `id` agree. A root's `previous` identifies its predecessor record; `null` introduces a root. Its `after` matches the generated companion schema digest; `null` records deletion.
- One initial `baseline: true` record covers the complete inventory. Routine changes use `baseline: false` and preserve accepted predecessors. A version-bump record carries its own increasing `SessionHeader.version` transition.
- Omit `--decision` in the ordinary authoring flow. An explicit value asserts the decision and cannot bypass classification or the required header increase. The command supplies no source changes or validation claims.
- Explain only the detected persistence-type changes. This kind permits the before/after facts and historical evidence needed for that transition; behavior-only changes remain out of scope.
- Record creation and terminal-record update generate the catalog pair and consistency sidecars. Review both languages and retain the generated companions. Direct prose edits still require re-recording pairing; do not hand-maintain schema nodes or digests.
- Use explicit `--update` only for an unaccepted terminal record. It rejects baselines and depended-on records; `--prose` replaces its authored explanations, while omission preserves them. Accepted records receive successors.
- The [folder reference](../../../../docs/persistence-changes/README.md) owns compatibility rules; the [cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) owns commands and recovery.
