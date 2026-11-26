---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-20-side-session-origin

English | [中文](2026-11-20-side-session-origin.zh.md)

## Summary

Adds the `side` value to the Session header `origin`, recorded on side conversations that `/side` forks.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-side-session-origin
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "80182de7c81ace88aba710f01dd7c66e10412a5e42645fe11d647c8eb237f3b2"
    decision: same-version
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "5bd0c9671b79261f42e5a47a308f7e5c7e15926a80e4a6e137a8bc66e70db09c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: absent `origin` and `origin: "subagent"` keep their meaning, and no migrated header can carry `side` because only the current writer produces it. The V4 codec passes `side` around the frozen V2 header codec, which still rejects it for real V2 logs. Released JSONL readers, including `dsh-v0.2.0-rc.2` and `dsh-v0.2.2-rc.5`, reject a `side` header during header validation: the format catalog reports it as malformed, the list skips the Session, and opening it raises a corruption error before any event is read, so no older reader executes, mutates, or truncates a side conversation. The SQLite backend released in `dsh-v0.2.3-alpha.2` decodes `origin` as the literal `subagent` under a strict header schema, so its `parseHeader` raises `SessionPersistenceCorruptionError` for a `side` header: the list omits that Session and opening it fails before any event is read. Its events and bytes stay unchanged for a newer reader. Header readers that branch on `origin === "subagent"` treat a side conversation as an ordinary Session.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/codec.spec.ts packages/session/session-persistence-sqlite/tests/codec.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/core/session/tests/session.spec.ts packages/api/session-controller/tests/session-fork.host.spec.ts: all tests passed, including the `side` round trip through the V4 codec, format catalog, JSONL header line, and SQLite codec.

Released SQLite reader: `git show dsh-v0.2.3-alpha.2:packages/session/session-persistence-sqlite/src/codec.ts` declares `origin: z.literal('subagent').optional()` inside a `.strict()` header schema, and the same tag's `src/sqlite.ts` wraps a decode failure in `SessionPersistenceCorruptionError`, which its list path omits.

<a id="dev-note"></a>
## Dev Note

None.
