# Agent Note: Session versions follow reader compatibility

Status: implemented

English | [中文](2026-10-08-session-reader-compatibility-review.zh.md)

## Problem

A structural schema difference does not establish that a Session needs a new integer version. An optional environment header field illustrates the cost: sessions that omit the feature can retain identical logs, while sessions that require it can be refused by older readers. A global bump also excludes feature-free sessions and requires a new generation and adjacent migration. Conversely, an unknown field or value does not establish safe refusal: permissive readers can ignore required meaning, and recovery can mistake unsupported records for damaged tails.

## Decision

The user chose reader behavior as the version criterion. A same-version change is permitted when older readers either resume correctly, safely ignore optional features while preserving their records, or refuse required features before execution, mutation, or tail repair. Feature absence must preserve existing behavior. Required-feature refusal needs an upgrade diagnostic; already released binaries retain their existing diagnostics, so review identifies any limitation explicitly.

New readers preserve the meaning of supported historical records and accept valid mixtures of old and new representations within one Session. Removing a required field or changing its representation is not automatically a bump: the replacement must remain distinguishable, and released-reader behavior must satisfy the same admission requirements. A version increase is required when no effective existing discriminator prevents unsafe interpretation. Reusing a logged value with a different meaning is one example; missing admission checks are another.

The schema classifier identifies structural changes requiring compatibility review instead of declaring them inherently version-breaking. Every schema difference still needs an acknowledgement. Established safe cases infer same-version; other same-version changes require an explicit decision when recording or updating. The existing Compatibility and Verification sections record reader behavior and executed checks. The checker validates the decision and recorded schemas; it cannot prove that the explanation matches runtime behavior. An explicit version-bump decision still requires its own increasing `SessionHeader.version`. Accepted machine records and checkpoints remain immutable; prose remains outside checkpoint hashes.

The user treats a recorded `same-version` decision as explicit regardless of whether the CLI or an editor produced it. The CLI requires `--decision same-version` for flagged record and update operations; CI validates the saved decision against history, schemas, and header-version constraints. Neither mechanism attests that a human reviewed the transition. Reviewers use base/head inventory comparison rather than current-tree consistency checks to inspect already acknowledged changes.

This decision partially supersedes the structural bump criterion in the [version-mechanism note](../architecture/2026-08-10-session-log-version-mechanism.md) and the automatic version floor in the [persistence-type-history note](2026-09-11-persistence-type-history.md). Their monotonic integer, required unknown-event default, type history, and immutable generation decisions remain active. The [review procedure](../../../../docs/cookbook/reviewing-persistence-type-changes.md) owns authoring and validation details.

## Migration obligations

One codec per integer version and one migration per adjacent pair remain sufficient. A version's reader supports its released representations without changing established meanings; an eventual successor migration accepts that same historical range, including mixed records. Historical conversion can keep producing a valid older representation within the target version. Same-version reads do not run an adjacent migration, so a compatibility claim cannot depend on an unimplemented normalization step. Header and payload extensions still need feature-specific admission and preservation through their actual consumers.

## Alternatives considered

**Require bumps for header changes and other structural edits.** This mechanically excludes safe refusal and optional features, imposing migration work even when existing discriminators already protect readers.

**Treat every unknown field or value as a refusal mechanism.** Released readers do not uniformly reject unknown values before recovery. Compatibility evidence must inspect the actual admission and mutation paths; a changed schema alone supplies no guarantee.

**Permit same-version changes without recorded reader evidence.** A schema graph cannot establish safe execution, lossless retention, historical interpretation, or mixed-record behavior. Explicit review preserves these obligations without making the classifier pretend to prove them.

**Add a separate JSON review object and hash its evidence.** The user rejected duplicating the existing Compatibility and Verification prose. Extra input fields and renewal rules add authoring work without establishing semantic safety. An explicit same-version choice and the existing acknowledgement keep the decision visible without a second evidence format.

## Consequences

The rule reduces unnecessary version transitions while making old-reader and new-reader evidence explicit. It changes review and acknowledgement enforcement, not runtime admission, diagnostics, codecs, or migration behavior. The environment example motivates the policy; it does not add an `env` field. Unsupported-feature detection, payload readers, and any necessary migration work remain obligations of each feature change. Focused verification must cover feature absence, optional retention or required refusal, historical input, and mixed representations as applicable; a written review is not a substitute for those results.
