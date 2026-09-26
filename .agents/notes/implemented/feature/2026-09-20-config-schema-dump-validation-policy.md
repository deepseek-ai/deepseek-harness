# Agent Note: Config schema dump validation policy

Status: implemented

English | [中文](2026-09-20-config-schema-dump-validation-policy.zh.md)

## Problem

`dsh --profile <name> --dump-config-schema` projects native Schemastery Config declarations into JSON Schema without mounting plugins. Native validation mutates its input, evaluates `!!js` expressions, and runs transform callbacks; a static document cannot reproduce all of that. Three choices were contested in review and would be reopened without a record: what `complete` and the exit code mean when part of the projection is approximate, which rows the collector inspects, and how the projection treats native behavior it cannot model.

## Decision

- **Partial projection exits 1.** `x-cordis.complete` is false and the CLI exits 1 for any error diagnostic, any `partial`, `unsupported`, or `error` entry, or one plugin name resolving to several Config definitions, even when stdout holds a valid and useful schema. The exit code answers whether the document can replace native validation, not whether output was produced. Callers that only need the schema read stdout and ignore the exit code; the diagnostics under `x-cordis` name each limitation at every entry it affects.
- **Discovery is declaration-oriented and includes disabled rows.** The collector walks every row the Loader would receive, including rows disabled literally or by expression, and imports their modules. A disabled row's import or include failure therefore makes a bootable profile incomplete. The one exception follows the Loader: a disabled group or include without `group: true` never creates its children, so a missing carrier config is recorded as a childless tree and the entry schema does not validate its child declarations.
- **Widen instead of simulating native mutation.** Where native resolution can alter the input before later validation reads it (adapted values written back by a container, renamed dictionary keys, loose fallbacks, lazy metadata propagation into shared nodes), the projection keeps the available declaration detail beside an unrestricted alternative and records a limitation. It never emulates the mutation. Widening is scoped to the mechanism: only containers write adapted values back, so a bare primitive transform as an earlier union branch keeps `anyOf`.

The [CLI reference](../../../../apps/cli/reference/README.md#config-schema-dump) documents the resulting behavior; [app-boot](../../../../packages/boot/app-boot/README.md) owns the collector API.

## Alternatives considered

**Exit 0 with a valid document and warnings only.** Rejected: a consumer feeding the schema to an editor or agent would treat an approximate document as authoritative. A nonzero exit forces the caller to decide explicitly.

**Skip disabled rows during discovery.** Rejected: a disabled row is a declaration the user is likely to re-enable, and its schema, id target, and import failures are what an editing agent needs. Skipping would also change `configRef` targets whenever `disabled` toggles.

**A relaxed child-list variant for ancestor-disabled children.** Rejected for now: it needs a parallel `entryList` and `entry` rule set with requiredness removed. Children under a disabled `group: true` row and patch insertions into a disabled group are validated as enabled, and the reference says so.

**Emulating native mutation in the projection.** Rejected: transform callbacks are plugin code the dump must not execute, and reproducing writeback order would couple the projector to Schemastery internals. A widening with a limitation is cheaper to maintain and cannot reject inputs that native validation accepts.

## Consequences

A shipped profile whose rows use an unsupported carrier reports `complete: false` and exits 1 while still emitting usable schemas, so consumers must read `x-cordis.diagnostics` to distinguish an approximate document from an unusable one. Every widening is paired with a limitation diagnostic, and generated schemas validate the `--dump-config` output of every shipped profile.
