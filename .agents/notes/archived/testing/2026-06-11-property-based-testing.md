# Agent Note: Property-based testing for protocol-shaped code

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-11-property-based-testing.zh.md)

> The property suite found a real BlockAssembler duplicate-`block-end` bug on its first run.

## Problem

Example-based tests pin the cases we thought of. The harness's core is protocol-shaped — chunk streams, event logs, schema conversion, inbox scheduling — where the input space is combinatorial and the interesting bugs live in interleavings nobody wrote an example for. The motivating evidence: a block-assembly ordering bug once survived 100% line coverage of the happy paths. Per-file 100% coverage proves every line ran, not that every interleaving is correct.

## Decision

`fast-check` (a root devDependency) powers one `tests/properties.spec.ts` per protocol-shaped package, with generators tuned for *realistic-but-adversarial* inputs (not uniform noise) and `numRuns` kept so the suite stays well under ~10s locally. Failures print a reproducible seed. (A nightly CI job running 100× the iterations is not shipped — the property suite runs only in the normal `push`/`pull_request` CI; a scheduled high-iteration job remains possible future work.)

- **dsh-llm / BlockAssembler:** arbitrary chunk streams (valid + malformed: duplicate indices, stragglers, missing block-start). Invariants: `blocks()` count ≤ distinct indices seen; re-assembly idempotent (`blocks()` is stable across repeated calls and `message().content` mirrors it); `blocks()` never throws and yields only valid content-block tags; `finish` reflects the last `finish` chunk, defaulting to `{kind:'stop'}` when none arrives.
- **dsh-session:** arbitrary event logs. Invariants: `deriveMessages` deterministic; replay-from-seed identical; seq strictly monotonic; non-message events never affect derived history; derived content is decoupled from the log.
- **dsh-tools:** arbitrary `ParameterSchemaSpec`. Invariants: JSON Schema `required` equals the `required:true` keys at every level; conversion is total for valid declarations; **and the composition with [runtime arg validation](../architecture/2026-06-11-runtime-arg-validation.md)** — generated args satisfying a spec pass `validateArgs`, and targeted corruptions (dropped required key, non-object top level) are rejected. Focused cases cover every value root, exact-one overlap/no-match, explicit openness, raw defaults, and lossy JSON. This closes the compiler/validator/`InferArgs` drift risk.
- **dsh-agent-loop:** arbitrary send schedules against a never-exhausting adapter, driven through the `agent/status` settle signal (no wall-clock sleeps). Invariants: no message lost; turn numbers strictly increase; status transitions stay on the legal machine.

## Consequences

- Generator quality is the value lever — the generators bias toward small index pools and short strings so collisions and interleavings are common.
- **It already paid off:** the BlockAssembler stream found a real bug — a duplicate `block-end` at the same index rewrote a completed block. Fixed (first close wins, matching the existing straggler rule) with a dedicated regression test.
- A property flake from a timeout is a finding, not something to retry away. The loop properties are deterministic by construction (settle on `agent/status`), so a hang is a real defect.
- Property tests supplement, not replace, the example tests that pin specific branches for the 100%-coverage gate.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
