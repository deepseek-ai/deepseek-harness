# Agent Note: Validate Remote inputs only on the Host

Status: implemented

English | [中文](2026-09-15-host-only-remote-input-validation.zh.md)

## Problem

Generated Client Remote methods expose TypeScript signatures and forward calls through Connection to a Host Gateway that already checks exact argument fields, executes each strict input codec, and verifies JSON data before lookup or business invocation. Executing the corresponding schema for every Client argument duplicates this validation, materializes otherwise lazy Zod schemas in the Client, and gives invalid JavaScript calls a different failure path depending on which side rejects them first.

The Client still needs descriptor metadata to check positional arity, map values to named wire fields, bind a scoped Context identity, omit an explicitly undefined optional value, and combine cancellation. None of these operations requires executing a runtime schema.

## Decision

Client Remote validates descriptor integrity when a contribution mounts, then forwards typed arguments and bound Context identities without calling invocation codec factories. It continues to reject wrong positional arity and missing Client Context bindings locally. Successful unary results and stream items also pass through without Client-side type parsing.

The Host Gateway owns runtime input validation. It checks the exact named fields, executes strict parameter and identity codecs, verifies JSON values, and completes lookup before invoking business code. A JavaScript caller that bypasses the generated TypeScript API receives the Host's `gateway/input-invalid` result when the request reaches the Host; a value that cannot enter the carrier may instead fail serialization.

Generated Remote contributions retain codec metadata because `InvocationDescriptor` remains shared between Host and Client artifacts and Client mounting still requires strict codecs for every Client-supplied field. The broader Remote architecture remains in [Typert-generated Remote method calls](../architecture/2026-08-02-typert-remote-method-calls.md); this decision supersedes only its Client-side invocation codec execution.

## Alternatives considered

- **Keep Client and Host input parsing.** This gives a malformed JavaScript caller an earlier local error and strips undeclared object properties before transport, but every valid call pays for duplicate schema materialization and parsing even though the Host must validate independently.
- **Remove codec metadata from Remote Client artifacts.** This could reduce generated Client code further, but it changes the shared descriptor and generator protocol. Keeping lazy factories preserves strict contribution checks without paying runtime schema construction cost.

## Consequences

Normal Client calls allocate no invocation schema and perform no duplicate Zod parse. Host validation remains the authority before lookup and business execution, while Client code retains arity, Context binding, cancellation, and contribution-lifecycle failures.

Malformed runtime values fail later than before. Undeclared object properties may cross the trusted carrier before the Host codec removes them, so callers that derive requests from untrusted or secret-bearing objects must construct the declared DTO rather than relying on Client parsing as a redaction step. Client tests pin unchanged forwarding, and Host tests pin strict and JSON input rejection.
