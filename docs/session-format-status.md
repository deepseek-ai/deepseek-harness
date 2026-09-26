# Session format version and release status

English | [中文](session-format-status.zh.md)

## Summary

Use this reference to distinguish the checkout writer, the accepted compatibility baseline, and the latest published Session format. The code constant owns the writer; the finalization and release records below separately identify accepted history and publication evidence. Other documentation links here instead of restating those values.

## Table of Contents

- [Sources of truth](#sources-of-truth)
- [Finalization record](#finalization-record)
- [Release record](#release-record)
- [Updating the record](#updating-the-record)
- [Dev Note](#dev-note)

<a id="sources-of-truth"></a>
## Sources of truth

- **Checkout writer:** `SESSION_FORMAT_VERSION` in [core Session types](../packages/core/session/src/types.ts) is the only hand-maintained current-writer number in code. The [catalog generator](../scripts/gen-session-format-catalog.ts) derives codec ordering and checks that adjacent migrations reach it. A package version, codec export name, fixture filename, or projection-cache version is not the writer authority.
- **Latest released format:** `latestReleasedVersion` in the following record identifies the published Session format. `evidenceTag` names a published product release whose tagged writer has that value; it need not be the first release carrying the format. The bilingual copy is checked against the same record, not maintained as a separate decision.
- **Release status:** compare the writer constant with the verified release record. Equality means the writer format has shipped. A greater writer version is not yet recorded as published; its finalization record independently identifies the accepted compatibility baseline. When comparing an older checkout against a newer branch’s verified record, a lower writer version identifies an older writer format; the local consistency gate rejects that ordering within one checkout. No separate released boolean is maintained. Before declaring a greater version unreleased, verify that no published release has advanced the record.

An alpha, beta, or release-candidate product publication establishes released Session-format obligations. GitHub’s prerelease flag does not make persisted user data disposable. A missing release record is not evidence of non-publication. The [versioning and authority decision](../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md) owns compatibility decisions; [released-format migration](../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) owns immutable generations and adjacent conversion.

The [format references](persistence-changes/historical-formats/README.md) document every integer from zero through the checkout writer, with historical schemas and the existing current catalog.

<a id="finalization-record"></a>
## Finalization record

```yaml session-format-finalization
latestFinalizedVersion: 4
```

V4 has an accepted compatibility baseline in the [checkpoint](persistence-changes/finalized/v4.json). Backward-compatible schema changes may remain V4 through new acknowledgement records. Breaking changes require a higher writer version and their own header transition; they cannot reuse the accepted 3→4 transition. Accepted machine records and after schemas remain immutable. [Checkpoint rules](persistence-changes/README.md#compatibility-rules) define the comparison.

Finalization does not freeze every future V4 addition and does not assert publication. The release record below retains the independently verified published version. Ordinary comments, aliases, source locations, and implementation fixes preserving the accepted meaning do not change this baseline.

Before the first V4 publication, every integration of a newer V3-writing master must pass the [explicit V3 vocabulary check](cookbook/adding-a-session-format-version.md#final-v3-vocabulary) against the recorded local source commit. Verify the source pin’s freshness and review new event payload conversions before updating the migration-owned set. After publication, the final V3 vocabulary remains historical and independent of current V4 additions.

<a id="release-record"></a>
## Release record

```yaml session-format-release
latestReleasedVersion: 3
evidenceTag: dsh-v0.1.5-alpha.1
```

Evidence: published product tag `dsh-v0.1.5-alpha.1`; tagged writer: `packages/core/session/src/types.ts`.

<a id="updating-the-record"></a>
## Updating the record

When a structural writer change is implemented, update the code constant and adjacent catalog together; do not advance this release record before publication. When a product release first publishes a higher Session format, confirm publication and its tagged writer, then advance this record and the evidence tag and tagged writer path in the same bilingual update. Later product releases carrying the same format do not require changing the record. Never lower it on the development trunk.

The [documentation-standard test](../scripts/doc-standard.spec.ts) checks record structure, bilingual equality, evidence-tag and writer-path consistency, and that the documented release does not exceed the checkout writer. This keyless check does not query GitHub or prove that the record is up to date; publication verification remains part of the release update.

Use “current format” and “next adjacent version” for general behavior. Keep explicit numbers for fixed migration inputs and outputs, wire schemas, historical evidence, and tests of those particular versions. The [format-version cookbook](cookbook/adding-a-session-format-version.md) uses N for the latest finalized or released format and N+1 for its successor.

<a id="dev-note"></a>
## Dev Note

None.
