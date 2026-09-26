# Agent Note: Separate Windows hardware signing from timestamp completion

Status: implemented

English | [中文](2026-09-17-windows-signature-completion.zh.md)

## Problem

A combined SignTool command reports timestamp failure as signing failure. Retrying it repeats hardware access, while treating every timestamp error as an uncertain private-key outcome requires administrator recovery. Public timestamp-only requests can fail independently of the token.

## Decision

Sign a private PE copy once without a timestamp. Release the hardware interlock only after successful execution and Windows verification of the configured primary signature. Hardware or primary-verification failures retain the interlock; no path automatically recovers it. Appended signatures are unsupported.

Timestamp fresh copies of the frozen signed file without signing credentials. Only normal failure or warning exits permit another attempt: at most three calls, with one- and two-second delays. Launch failures, uncertain termination, storage changes and verification failures stop immediately. The preflight's overall 60-second deadline includes these operations and does not guarantee three full subprocess deadlines.

Require Windows trust, timestamp and certificate identity. Remove unsigned signature attributes from private copies with the configured SignTool and compare their complete normalized bytes. A removal warning is accepted only when all bytes remain unchanged. Certificate equality alone cannot exclude different content signed by the same certificate; full-file equality avoids a custom PE or ASN.1 canonicalizer.

SignTool uses short filenames with the original extension in a private temporary directory. Its longest generated path is checked before hardware access, and the journal records the original-to-staged mapping. The target may occupy another volume: copy verified bytes into a private directory beside it, compare hashes, recheck the original and rename within that volume. Verify committed bytes afterward. The build account must own trusted storage and exclusive target access.

Exhausted timestamp attempts stop packaging and queued work without another hardware call. Failure evidence is copied to the supervised run before staging cleanup; evidence or audit failure preserves staging. Final artifact verification and release completion remain mandatory. The [primary-runtime decision](../feature/2026-09-14-desktop-primary-runtime.md) owns runtime contents and vendor signatures.

## Alternatives considered

**Retry combined signing or classify diagnostic text.** Exit codes and localized text cannot establish the private-key outcome. Separate operations avoid repeated hardware access.

**Reuse failed timestamp output.** A failed process may partially modify its file. Every attempt starts with identical verified primary-signature bytes.

**Stage beside each target for all operations.** Nested dependencies can exceed SignTool's path limit even when the original fits. Short tool paths and same-volume publication address separate requirements.

## Consequences

Fault tests cover lock retention, isolated timestamp retries, queue rejection, credential exclusion, substituted content, changed targets, long paths and evidence failures. Public-only qualification covers EXE, DLL, PYD and NODE files, including failure followed by success and cross-volume publication. A real supervised signing preflight has passed; complete installer comparisons remain separate qualification. This decision does not identify or repair the timestamp service's network failures.

DigiCert [supports separate signing and timestamping](https://knowledge.digicert.com/solution/troubleshooting-timestamping-problems). Microsoft documents [SignTool commands and exit codes](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool). The configured tool and normalization implementation participate in signature-cache identity.
