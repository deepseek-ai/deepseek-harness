# Agent Note: Parse SSH policies once at request admission

Status: proposed

English | [中文](2026-10-18-parse-ssh-policy-once.zh.md)

## Problem

The [`sandbox` and `fs.write`/`fs.edit` handlers](../../../../packages/ssh/ssh/src/helper.ts) are the private policy resolver's only callers. They validate requests with `policySchema`; the resolver repeats that parse, including a policy and extra-root array copy.

## Proposal

Accept `z.output<typeof policySchema>` in the private resolver and remove its parse. Retain both wire parsers, execution-host path resolution, cancellation, SessionId branding, and explicit omission of undefined optional fields. The [SSH execution decision](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md) continues to own remote policy enforcement.

## Alternatives considered

**Keep the resolver's unknown input.** It protects future unparsed callers, but current callers already decode. A typed parameter states the required precondition without repeated runtime work.

## Acceptance criteria

Both request handlers still reject malformed policies, relative roots, and unexpected fields. Remote physical-root checks and returned policies remain unchanged. Existing helper tests cover absent and supplied roots, read-only policy, and denied writes.

## Risks

A future wire caller must validate before invoking the resolver. Preserve optional-field omission because Zod permits explicit `undefined` while the execution-policy type does not.
