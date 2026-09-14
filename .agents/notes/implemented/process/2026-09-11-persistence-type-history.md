# Agent Note: In-tree persistence-type history

Status: implemented

English | [中文](2026-09-11-persistence-type-history.zh.md)

## Problem

A persisted event can retain the same payload type expression while a referenced type changes. Reviewing declaration text alone does not expose every nested structural change. A digest detects a difference but cannot explain whether it adds optional data or changes an existing property. Regenerating a catalog also does not establish that the author reviewed the persistence consequences.

## Decision

One normalized type model supplies the readable persistence catalog, the complete schema inventory, and transitive per-root digests. Roots identify the logical Session header, the physical JSONL header line, the event envelope, and every repository-declared event. Source locations, alias names, comments, and property order are presentation details outside the digest. Historical records retain source file paths without line numbers because their selected source trees differ from the current checkout. Referenced and recursive types participate in structural comparison; opaque values retain explicit coverage limits.

The dedicated [persistence-change records](../../../../docs/persistence-changes/README.md) bind acknowledgement to the after digest of each affected root. A generated companion stores complete after schemas. The initial record covers all roots; later records name each root's predecessor. A predecessor's after schema supplies the next before schema. Verification rejects ambiguous history and requires current source to match the terminal recorded state without consulting Git history or remote services.

Automatic classification permits optional body additions, required-to-optional body changes, and ordinary event additions within one version. Other structural changes require a version-bump decision that includes an increasing header version in that record. The [format-version procedure](../../../../docs/cookbook/adding-a-session-format-version.md) continues to own adjacent migration work. Every structural difference requires an explicit record, including additions allowed within the same version.

The new document kind preserves the compatibility reasoning and evidence for a historical type transition. Agent Notes retain mechanism-level decisions; they do not become a growing inventory of individual acknowledgements. Machine declarations remain identical across the bilingual pair and are parsed once.

Retrospective [release comparisons](../../../../docs/persistence-changes/releases/README.md) use a separate `persistence-release` kind and pinned tag manifest. They retain changed after schemas and reconstruct adjacent releases, including unchanged tags. Earlier releases predate these acknowledgement rules, so their classifications are informational and their observed versions are not rewritten to satisfy a modern version floor. Historical parsing preserves optional surface operations; the current parser and acknowledgement chain remain strict. This separation permits approximate backfills without turning them into authorization for current changes.

The [format references](../../../../docs/persistence-changes/historical-formats/README.md) preserve complete inventories for every historical integer below the writer constant. The current writer retains the existing generated catalog. Coverage is derived from the constant rather than a hand-maintained version manifest, so advancing the writer requires archiving its predecessor. The archive command copies the validated current inventory, retains its root-reachable definitions, removes source line numbers, and refuses to overwrite an existing snapshot. Source checkpoints remain explicit because event additions and optional payload changes can occur within one format; these snapshots do not authorize current changes or claim migration safety. Historical identifiers are retained in machine schemas and exactly generated schema regions, while current terminology checks still cover the surrounding authored prose.

Record commands generate the bilingual catalog and consistency records from repository-owned templates. Authors can supply the two languages' summary, compatibility reasoning, and actual verification evidence as structured input. Generation supplies identifiers, digests, and snapshots; it never invents a compatibility explanation or test result. Structured check output retains a nonzero failure exit status and reports stable change kinds independently of human-readable descriptions.

Explicit update refreshes an unaccepted terminal record without deleting its authored prose. It recomputes the transition against the remaining history and rejects the baseline or any record with dependants. Review acceptance is not a fact available from the tree, so authors preserve accepted records and add successors.

## Alternatives considered

**Hash the displayed declarations.** Referenced definitions can change without altering the displayed expression. Normalized transitive types make those changes visible while omitting source-file and alias churn.

**Bind every acknowledgement to one overall digest.** An unrelated event change would invalidate a reviewed acknowledgement. Per-root history limits invalidation to the affected header or event while the complete inventory retains coverage.

**Compare with the PR merge-base or a release checkout.** Those inputs require history outside the current tree. Retained after schemas provide the comparison input to local checks and CI alike. A hash without its schema cannot support automatic structural classification.

**Treat every changed digest as a version bump.** Optional body additions, required-to-optional changes, and ordinary event additions do not always require a new persistence version. Conservative classification distinguishes these cases and leaves the compatibility explanation to review.

**Infer behavior from types or permit arbitrary compatibility overrides.** A type graph cannot prove replay semantics. The checker confines itself to detectable structure and rejects decisions below the mechanical classification; it does not claim to detect behavior-only changes.

## Consequences

Authors retain one snapshot per affected root per accepted transition and resolve history forks when integrating competing changes to that root. Independent roots can advance without rewriting unrelated acknowledgements. The [cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) provides the local authoring and verification procedure.

The checks prove current-tree consistency, not that accepted history was never rewritten or that an explanation is semantically correct. Hidden structures inside `unknown` and similar opaque values remain undetectable. This mechanism adds no runtime digest or Session-format field. Existing [versioning](../architecture/2026-08-10-session-log-version-mechanism.md) and [released-generation migration](../architecture/2026-08-31-released-session-format-migrations.md) decisions retain their independent runtime guarantees.
