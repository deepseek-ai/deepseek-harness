# Agent Note: Producer-owned message sources at the V4 edge

Status: implemented

English | [中文](2026-09-09-producer-owned-message-sources.zh.md)

## Problem

Released V3 plugin attribution uses the shared wrapper `{ kind: 'plugin', plugin: '<producer>' }` plus the producer's context-form fields, so consumers had to treat one synthetic kind specially instead of switching on the producer identity. Once tool results became first-class tool-role messages and the current generation moved to V4, the format layer also had to keep reading released V3 files whose rows still carry the wrapper.

## Decision

Message sources are producer-owned: `kind` identifies the producer, with declarations contributed through `MessageSourceMap`. The V3-to-V4 migration uses its fixed producer table: `@deepseek-ai/dsh-system-prompt` becomes `system-prompt` for system-role messages and `runtime-context` otherwise; `compact` becomes `compact-checkpoint`; `tools-code-mode` and `tools-ptc` become `ptc-mode`; `dsh-compaction-basic` becomes `compact-basic`; known same-name producers retain their kind. Unknown plugin names receive `plugin:` before the complete original name, while direct source kinds retain their original names. The prefix keeps a plugin named `user` separate from the human-user kind; this edge leaves direct attribution unchanged. Original context-form fields and other own JSON metadata survive; only the old wrapper's identity fields receive their specified conversion. Rename lookup uses own keys, so `__proto__` and `constructor` remain data.

Native V4 source admission rejects the retired `kind: 'plugin'` wrapper in every declared durable message slot, including inbox and title-request messages. This refusal applies before recoverable scanning can discard a suffix. Complete source-slot validation runs in the shared known-event pass used by both the format catalog and native JSONL scanner, before either exposes a restored artifact or handle. Unknown nonempty attribution kinds and their extra JSON fields survive without their producer installed. Native compaction and title relationship checks use the producer kinds directly; the [mandatory validation decision](2026-09-17-native-v4-read-validation.md) owns common lifecycle rules.

The source rewrite is owned by the V3-to-V4 migration stage and runs once while historical events become V4 events. The current V4 codec retains only the released physical framing and native V4 admission; it never sends a V4 row through the released V3 validator and has no source-conversion view in its encode, decode, restore, or row-admission paths.

Recorded current V4 fixtures and writer, notification, and stream-json sidecars are producer-owned; released V2/V3 fixtures and sidecars keep plugin attribution and convert at read time through the migration. The [released session-format migrations](2026-08-31-released-session-format-migrations.md) note owns the versioning rules this edge follows.

The [source-attribution policy](2026-09-17-persistence-attribution-policy.md) distinguishes durable source declarations from request-only user inputs and records the narrowly scoped compatibility promise for new attribution kinds. Frozen migration rules retain historical producer kinds even when no active producer declares them.

## Alternatives considered

**Keep the released plugin wrapper as the current shape.** Consumers would keep switching on one synthetic kind and the producer identity stays an untyped string; the current semantic validators would keep a second, unreleased source vocabulary.

**Rewrite released rows only at scan time instead of migrating them.** Scan admission is deliberately shape-only and refuses, never repairs; a scan-time rewrite would blur released generations with current rows and leave the current artifact with version-inappropriate source identities.

**Reject plugin-kind rows as ordinary corruption in the scanner.** That would let a stale released row silently truncate a current Session instead of surfacing a refusal, and would misclassify rows that full decoding still needs to diagnose.

## Consequences

The recorded corpus for this migration applies the frozen rename table, while current-generation validation consumes producer-owned kinds directly. Web context labels render the producer kind (`runtime-context`) instead of the released plugin string. The shared rewriter reports malformed released sources as `SessionFormatError`, so a malformed historical source is a migration refusal rather than a silent payload loss.
