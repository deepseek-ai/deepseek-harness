# Agent Note: Web session-log export as a host-streamed ZIP download

Status: implemented

English | [中文](2026-08-10-web-session-log-export.zh.md)

## Problem

The Trajectory view had no way to hand a debugging artifact to a human: the raw session log lived on disk and in the host, the client history face served folded projections (not raw entries), and a session with subagents spans many independent session logs. A bug report needs the complete raw log of the whole tree, in a shape that survives being emailed around.

## Decision

- **The export is a host-only download, not an RPC**: `GET /api/session.export?sessionId=…&includeDescendants=true` streams one ZIP attachment. Every Session file is canonical current JSONL produced from a persistence read handle: one v2 header row followed by one validated durable event per row. Backend-specific generation names, Zstandard framing, and historical packed rows stay behind the persistence seam; the archive always uses `session.jsonl` at the root and `subagents/<id>/session.jsonl` for descendants. Compression runs on the host with fflate's streaming `Zip`/`ZipDeflate` API at validated `sessionExportCompressionLevel` 0–9 (default 6), letting deployments trade CPU and latency against archive size; each entry is deflated in bounded chunks as it is produced, so the response is chunked as it is generated and the host never holds the whole archive in one buffer (at most one descendant's log text beyond the preloaded root). At the 64 KiB response byte high-water mark, production waits for consumer pull to restore capacity; fflate's synchronous callback can add at most one bounded input push beyond that queue bound. No manifest is written — each log is self-describing through its header and embedded v2 lineage marker, while referenced media keeps its content-addressed archive path.
- **Error vocabulary is HTTP-native**: missing services → 500 and missing root session → 404, both decided before any byte streams; a descendant without a stored log or referenced media object errors the stream (fail-loud, never silent under-export). Request abort remains cancellation instead of being rewritten as 500; request and response-consumer cancellation converge on the producer signal, which reaches lineage, persistence, and attachment reads and terminates the active compressor. Connection applies the `/api` trust fence before dispatching the exact `GET`/`HEAD /api/session.export` route registered by `session-log-export`.
- **The UI just downloads**: browser consumers may issue a bodyless `HEAD` preflight for preparation errors, then hand the GET endpoint to the browser's native download manager, so JavaScript never buffers the ZIP. The `session.log` RPC that an earlier iteration shipped was removed — the download endpoint is its only consumer, and the repo rule is no public interface without a current owner. The client bundle carries no archive implementation.
- The current Header and `/export` consumers are defined by the [session-log export package contract](../../../../packages/session-query/session-log-export/README.md).

## Alternatives considered

- **`session.log` data RPC + client-side zip** — shipped first, rejected with the user: the browser pulls the full raw JSON (≈10× the final zip size) and compresses on the main thread; for the 23 MB sessions in real use the host-side stream is strictly better. The RPC was deleted with the migration rather than left as a dead public surface.
- **Single JSONL with envelope lines for multiple sessions** — rejected with the user: mixing sessions in one JSONL loses clean per-file boundaries; a ZIP keeps one canonical file per session.
- **jszip** — heavier (~100 kB) and its dependency graph pulls readable-stream browser mappings; fflate is purpose-built and small.
- **Vendoring fflate's browser entry** — the repo vendoring procedure targets cordis-scale pinned sources; a resolveId alias keeps the maintained dependency without shipping a copy (and host-side fflate needs no alias at all).

## Consequences

- Export fidelity: immediately before reading each live root or descendant, the exporter crosses the authoritative `SessionStore.flush` durability barrier; every exported file represents that validated durable logical log in the same current JSONL form, independent of backend framing. A live session may append again after its read, so the archive is a per-session read-boundary snapshot rather than one atomic tree snapshot. The archive name is `dsh-session-<sanitized-id>.zip` and archive paths sanitize ids before they can shape entries.
- The export needs no seam capability: each log is read through a persistence read handle and serialized here as canonical JSONL, so any mounted backend exports identically ([export and pre-release trims](../simplification/2026-08-27-persistence-export-and-pre-release-trims.md) records the removal of the earlier verbatim-artifact surface). Absence is decided by a `stat` preflight (absent session → 404). `session-log-export` registers one exact Host-only Fetch route with Connection; no Remote descriptor or JSON envelope represents the streamed response.
- Fixture mode (no host) answers 404 for the export, which the browser reports as a failed download; the navigation-panes golden snapshot includes the 导出 button.
- Deferred: transcript.md and a report/feedback bundle remain future work; the stable per-session JSONL and manifest-free layout keep that extension cheap.
