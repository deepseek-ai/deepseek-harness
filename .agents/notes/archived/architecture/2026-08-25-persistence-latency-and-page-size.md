# Agent Note: JSONL persistence compression latency

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-25-persistence-latency-and-page-size.zh.md)

## Problem

Physical persistence optimizations need to reduce retained storage without moving disproportionate work into full writes, reads, or Session forks. The original 105-Session corpus showed that JSONL level-19 compression made full writes and forks more than twice as slow.

The decision needs evidence from more varied sessions, including long event streams and payloads outside the original corpus. The expanded corpus contains 501 real sessions, 16,153,332 logical events, and 2,002,145,570 bytes of serialized event data.

## Decision

### Storage encoding stays physical and independently decodable

JSONL stores strictly increasing `sourceEventSeqs` as mixed scalar values and inclusive ranges; other orders remain verbatim. Reading restores the original `number[]` before exposing an event.

### JSONL uses the standard Zstandard level

The JSONL writer keeps one checksummed Zstandard frame per durable append batch but uses the compressor's standard level. Lossless `sourceEventSeqs` range encoding remains active. Frames stay independently decodable for suffix reads and torn-tail recovery; only the expensive level-19 search is removed.

### Expanded benchmark

Each candidate was rebuilt five times from the same 501-session corpus with 512-event append batches. Their order rotates between rounds so every candidate occupies each run position once. Each build runs three complete and suffix-read sweeps. For each displayed metric, the highest and lowest build are discarded and the remaining three values are averaged. Complete and suffix read times cover one sweep over all sessions, and fork time covers all 501 sessions.

| Backend | Stored size | Full write | Full read | Suffix read | Fork |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSONL `master` | 172.43 MB | 200.902 s | 8.033 s | 24.479 s | 72.670 s |
| JSONL with provenance ranges | 148.15 MB (-14.1%) | 197.281 s (-1.8%) | 7.799 s (-2.9%) | 24.582 s (+0.4%) | 72.308 s (-0.5%) |
| JSONL with provenance ranges and level 19 | 130.22 MB (-24.5%) | 329.442 s (+64.0%) | 7.764 s (-3.3%) | 24.454 s (-0.1%) | 166.177 s (+128.7%) |

Relative to standard-level frames with provenance ranges, level 19 saves another 12.1% of the JSONL bytes but increases full-write time by 67.0% and fork time by 129.8%. Its complete and suffix reads change by -0.4% and -0.5%. The extra search therefore benefits retained size without improving the latency-sensitive operations enough to offset its repeated encoding cost.

## Alternatives considered

**Keep JSONL level 19.** Rejected. On the expanded corpus it saves another 12.1% relative to default-level frames but increases full-write time by 67.0% and fork time by 129.8%, while complete and suffix reads differ by less than 1%. Default-level frames plus provenance ranges retain a 14.1% size reduction relative to master without a material latency regression.

**Compress one whole JSONL log as a single frame.** Rejected. It improves cross-batch compression but makes suffix reads decompress from the start and removes batch-local torn-tail recovery.

**Deduplicate event content.** Rejected. Message restatements and tool arguments can be reconstructed only under assumptions that compaction, retries, and pruning may invalidate. Physical compression preserves every event without adding reconstruction semantics.

## Consequences

JSONL keeps the low-cost provenance optimization without the level-19 write and fork penalty. The expanded corpus measures a 14.1% retained-size reduction from provenance ranges without a material latency regression.

## Related

- [JSONL-only first-party Session persistence](../simplification/2026-08-30-jsonl-only-session-persistence.md) — owns deletion of the alternative authoritative backend; the [archived SQLite compression record](../../archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) retains its historical measurements.
- [zstandard-jsonl-session-logs](2026-07-19-zstandard-jsonl-session-logs.md) — owns the checksummed frame-per-batch container and the standard compressor-level policy restored here.
