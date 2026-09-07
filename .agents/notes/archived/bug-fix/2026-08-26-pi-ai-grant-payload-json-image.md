# Agent Note: pi-ai grant payloads store their JSON image

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-pi-ai-grant-payload-json-image.zh.md)

## Problem

A GitHub Copilot sign-in against github.com failed at its commit step: `credentials-local: record "llm-pi-ai/github-copilot" payload holds a value JSON cannot represent`. pi-ai's Copilot credential carries its optional members as explicit `undefined` (`enterpriseUrl: undefined` when no Enterprise domain was given — idiomatic JavaScript that `JSON.stringify` would simply drop), and `llm-pi-ai`'s store bridge committed the credential object verbatim as the grant payload. The credential store's validator rightly refuses `undefined` as unrepresentable, so every grant whose flow left an optional member unset failed to store, and the sign-in reported failure after the provider had already authorized it.

## Decision

`toRecord` in `packages/llm/llm-pi-ai/src/auth.ts` stores the JSON image of a grant credential: `jsonImage` drops explicitly-undefined members of plain objects and renders undefined array entries as `null`, exactly as `JSON.stringify` would. Everything else — non-finite numbers, foreign-prototype objects — passes through untouched, so a genuinely unstorable value still fails loud at the store's validator rather than being silently reshaped. Reading back is unchanged: an absent member and an explicitly-undefined one are indistinguishable to pi-ai's consumers, which access optional members by property read.

## Testing

`tests/auth.spec.ts` writes the Copilot-shaped grant (explicit `undefined` member, nested drop, array hole) through the real `LocalCredentialProvider` and asserts the stored payload is the JSON image; a second case proves the fail-loud path survives by committing a `Date`-valued member and asserting the store's refusal reaches the caller.

## Alternatives considered

**`JSON.parse(JSON.stringify(credential))`.** Rejected: it also renders `NaN`/`Infinity` as `null` and runs `toJSON` methods, silently reshaping exactly the values the strict validator exists to refuse loudly.

**Relaxing the store validator to skip `undefined` members.** Rejected: the seam stores payloads it never reads or reshapes, and every producer relies on byte-faithful round-trips; normalization belongs to the producer that knows its library's idiom, not to the store every plugin shares.

**Fixing pi-ai upstream to omit unset members.** Out of this repository's hands and version-fragile: any future flow reintroducing the idiom would break sign-in again. The bridge owning the translation makes the harness robust against the whole class.

## Consequences

Grants from every pi-ai flow store regardless of which optional members the flow left unset. The bridge now owns a one-way normalization: a payload read back lacks members that were explicitly `undefined` at write time, which is indistinguishable from their absence for property access, and remains the documented JSON semantics.
