# Agent Note: incremental terminal retention

Status: implemented

English | [中文](2026-09-11-incremental-terminal-retention.zh.md)

## Problem

Persistent terminal output passes through scrollback and unread-send byte limits on every PTY callback. Rebuilding the entire retained string to enforce those limits makes callback cost grow with retained output. A 4 MiB scrollback window makes this repeated work substantial even when each incoming chunk is small.

## Decision

The private buffer in [terminal-bash](../../../../packages/terminal/terminal-bash/src/session.ts) retains a linked sequence of strings, a head offset, and aggregate UTF-8 byte and newline counts. Appends inspect incoming text and evict only the oldest code points until both limits hold. Every evicted code point is charged to an earlier append, so total retention work is linear in input size. Reads assemble the retained strings; they remain proportional to retained output.

The retained suffix matches line trimming followed by UTF-8 trimming. A trailing newline contributes an empty logical line. Truncation stays sticky until consumption clears the buffer. Adjacent surrogate halves across chunks count as one four-byte code point and are evicted together; unpaired halves retain JavaScript string identity and count as three UTF-8 bytes. The read-time `utf8Tail()` remains independent and unchanged.

Every nonempty input is copied through UTF-16 before retention, preserving unpaired surrogates while detaching slices returned by the sanitizer from discarded control text. This applies to small pending fragments as well as large chunks. Private `truncated` and `isEmpty` getters let send settlement and startup polling inspect status without assembling scrollback.

After at least half of the leading string is discarded, its suffix is copied to release the original backing storage. The copy costs no more than the discarded prefix, preserving amortized linear work and bounding retained string storage by the retained window. Linked nodes avoid array shifts or periodic scans of all retained chunks. Small inputs coalesce in the non-head tail up to 4096 UTF-16 units; allocating its successor copies those fragments into one owned string. Large tails already own their storage and are not copied again at this point. The head never grows during appends, and a cached last code unit avoids flattening pending fragments to inspect a cross-chunk surrogate pair. This bounds fragment metadata even for one-byte callbacks without rescanning retained text.

The [persistent PTY decision](../feature/2026-07-16-persistent-pty-sessions.md) continues to own session lifecycle, model-visible output, and retention semantics. This decision specializes storage and performance; it supersedes no active decision record.

## Measurement design

The terminal I/O benchmark drives `LocalPtySession` with a synthetic subprocess handle. Fixed 16 KiB ASCII chunks without newlines exercise the byte limit with a long logical line. Steady-state cases fill either a 128 KiB or 4 MiB window, then append the same additional 1 MiB. A separate empty-window case sends 5 MiB. The line limit is 10,000; unread output is limited to the smaller of 256 KiB and the scrollback capacity.

Synchronous ingestion measures the send start and provider callbacks. Completion additionally waits for emulator processing and readiness, then reads the bounded terminal result. Retained heap is sampled after explicit GC while the session and returned output remain reachable. Built JavaScript runs under plain Node. These measurements exclude shell startup, operating-system PTY transport, model latency, and browser rendering.

### Local reference measurements

On Apple M5 Pro, macOS arm64, Node v26.5.0, five fresh workers per case compare the eager-retention baseline with incremental retention. The same worker and inputs measure both versions; only the private session implementation differs. Times below are milliseconds in sample order.

| Case / metric | Eager retention samples | Incremental retention samples |
|---|---|---|
| 128 KiB steady / ingestion | 232.164, 234.564, 219.511, 219.615, 221.434 | 10.493, 10.474, 9.917, 10.524, 10.327 |
| 128 KiB steady / completion | 245.365, 247.826, 233.322, 232.854, 234.926 | 19.600, 19.991, 19.290, 20.049, 19.773 |
| 4 MiB steady / ingestion | 4159.780, 4271.184, 4179.700, 4223.583, 4128.541 | 8.752, 8.584, 8.808, 8.582, 10.073 |
| 4 MiB steady / completion | 4183.374, 4296.630, 4205.122, 4247.787, 4151.634 | 29.760, 30.679, 31.510, 31.781, 37.748 |
| 5 MiB send / ingestion | 5186.998, 5122.875, 5127.790, 5177.788, 5157.274 | 26.440, 27.453, 26.710, 26.328, 27.334 |
| 5 MiB send / completion | 5297.536, 5181.298, 5182.416, 5234.920, 5211.802 | 89.475, 83.310, 88.491, 89.440, 89.339 |

The large/small steady-ingestion median ratio is 18.88 for eager retention and 0.84 for incremental retention. The 5 MiB completion median falls from 5211.802 ms to 89.339 ms (58.3×). Maximum retained heap for the large steady case rises from 4,512,656 to 6,219,296 bytes; this measures live session and result allocations together, not just buffer strings.

A separate memory case sends 5 MiB in 16-byte callbacks and samples retained heap once after completion. It retains 5,802,840 bytes with tail aggregation. The same assertion with uncoalesced linked nodes fails at 22,969,720 bytes against the 16 MiB bound. This case has no performance timing verdict.

The filtered-output memory case emits 513 callbacks of 64 KiB each, containing a complete 56 KiB OSC sequence followed by 8 KiB of visible text. This passes through the production sanitizer before filling a 4 MiB visible window and taking a bounded read. With incoming slices retained directly, the assertion fails at 36,706,592 bytes. Copying inputs into independent storage reduces retained heap to 7,635,440 bytes, below the unchanged 16 MiB limit. These measurements use Node v26.5.0 and fresh workers.

A real PTY diagnostic runs `node -e 'process.stdout.write("x".repeat(5*1024*1024))'` through the built local subprocess provider. One baseline sample takes 106962.523 ms; one final candidate sample takes 249.007 ms. Timing begins before PTY/process spawn and ends after `session_exit` and the bounded read. Both samples exit with code 0, no signal, and truncated 256 KiB viewport/read payloads. This includes native PTY transport and Node startup, but excludes an interactive shell and prompt-readiness round trip.

The [required benchmark](../../../../benchmarks/terminal-io/terminal-io.bench.ts) applies the shared CI scale and headroom to reference expectations of 20 ms steady ingestion, 50 ms steady completion, and 120 ms full completion, yielding limits of 50/125/300 ms. Median capacity scaling must stay below 4×; maximum retained heap is 16 MiB. Ratios and memory limits are unscaled. Substituting the original compiled session worker makes both timing cases fail: capacity ratio 18.977 exceeds 4, and full completion 5066.719 ms exceeds 300 ms. The final worker passes all four cases. The local benchmark command is `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/terminal-io/terminal-io.bench.ts` after the benchmark build.

## Alternatives considered

**Cache only the byte count.** This leaves the per-append line split and full-string prefix deletion dependent on retained output. Both limits need incremental accounting.

**Keep the complete output until a read.** This makes producer cost small but permits unbounded retention between reads. The configured limits apply during production.

**Retain one node per callback.** Tiny callbacks make node metadata much larger than the bounded text. Bounded tail aggregation keeps node count tied to stored text blocks.

**Store encoded UTF-8 chunks.** Encoding replaces unpaired UTF-16 surrogates. String chunks preserve the existing buffer semantics without adding a second text representation.

## Consequences

Append-time work no longer depends on repeatedly scanning the retained window. Snapshot and consume still allocate a combined string. Retention adds linked nodes and a bounded collection of pending small fragments. Functional tests cover byte/line interactions, consumption, split surrogate pairs, and 4 MiB retention. Performance evidence complements these output assertions; a synthetic provider does not establish real-shell command latency.
