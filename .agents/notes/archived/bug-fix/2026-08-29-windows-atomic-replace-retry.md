# Agent Note: Retry transient Windows atomic replacements

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-29-windows-atomic-replace-retry.zh.md)

## Problem

Windows can temporarily reject a rename that replaces an existing file with `EACCES`, `EBUSY`, or `EPERM` while another system component holds the target. The cross-process writer lock orders cooperating application writers but cannot release that external handle, so treating the first error as permanent makes an otherwise valid settings or credentials update fail nondeterministically.

## Decision

`writeFileAtomic` owns replacement retry because every file-backed store needs the same guarantee. On Windows only, it retries `EACCES`, `EBUSY`, and `EPERM` up to eight times with exponential delays from 20 to 200 milliseconds. The same fully written temporary sibling remains the rename source throughout, and a caller-held writer lock remains held until `writeFileAtomic` settles.

Other error codes and other operating systems fail immediately. Exhausting the retry budget rethrows the final filesystem error after removing the temporary sibling; the existing target remains unchanged because no attempt deletes or truncates it.

## Alternatives considered

**Retry the credentials mutation.** A consumer-level retry would leave settings and future stores exposed, and replaying a read-modify-write operation can repeat work outside the atomic replacement. The shared primitive is the narrow owner of replacement-only retry.

**Delete the target before rename.** Removing the target can make readers observe an absent file and forfeits atomic replacement, so it cannot be a recovery step.

**Retry indefinitely.** A permanent permission error would then hang the writer and any lock contender. A bounded delay absorbs transient file use while preserving a predictable failure outcome.

## Consequences

A transient Windows handle can delay one replacement by at most 1.1 seconds before the final attempt fails. During that interval readers continue to see the complete old target, and success still consists of one atomic rename. Regression tests inject every retried code, permanent and non-Windows failures, and retry exhaustion; they observe rename attempts and advance fake timers rather than depending on wall-clock sleeps.
