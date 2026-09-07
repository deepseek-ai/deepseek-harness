---
description: "Package map for the session retrieval capability family: searching, tracing, and reading live and durable session history, plus the Web session-log export."
kind: "package-group"
---

# session-query/ — session retrieval capability family

English | [中文](README.zh.md)

## Summary

The `session-query/` group provides retrieval over live and durable session history, independent of compaction: programmatic callers query one unified service for exact logs, filtered lists, relationship traces, and full-text search; a SQLite backend powers the search; the model gets five workspace-authorized tools; and the Web UI gets an `/export` command that downloads a session ZIP. Search results agree with the conversation history the model sees. This page maps the group; each package README owns its per-package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package README describes what you can do with its part of the family.

| Package | Role | ctx key |
|---|---|---|
| [`session-query/`](session-query/README.md) | Unified session-history query service: exact reads, relationship traces, and filters | `ctx.sessionQuery` |
| [`session-query-sqlite/`](session-query-sqlite/README.md) | Full-text search across session history backed by a SQLite FTS5 index | registers on `ctx.sessionQuery` |
| [`session-log-export/`](session-log-export/README.md) | Web `/export` command and browser download of a session ZIP | `ctx.sessionLogDownload` (browser) |
| [`tool-session-query/`](tool-session-query/README.md) | Model-facing tools to search, trace, and read session history | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared query vocabulary, then the design records behind tracing and search.

- [Session Query subsystem reference](../../docs/subsystems/session-query.md) — logical records, filters, search pages, lineage, bounded reads, and event relationships.
- [Session query relationship tracing](../../.agents/notes/archived/feature/2026-07-13-session-query-tracing.md) — trace semantics and the validation boundary.
- [SQLite FTS5 session search](../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md) — search semantics, reconciliation, and the tokenizer decision.

<a id="dev-note"></a>
## Dev Note

None.
