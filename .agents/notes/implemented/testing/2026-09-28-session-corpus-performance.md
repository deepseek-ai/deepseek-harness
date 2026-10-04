# Agent Note: Performance baselines for large Session corpora

Status: implemented

English | [中文](2026-09-28-session-corpus-performance.zh.md)

## Problem

Existing gates measure one long Session: [opening it](2026-09-04-session-open-performance-gate.md) or [continuing it](2026-09-06-backend-continuation-performance.md). Listing, content search, and fork scale with the whole corpus or with the source Session's length, and no gate covered a user with many long Sessions. A corpus of uniform small Sessions would understate the work, because real corpora are heavy-tailed.

## Decision

The [session-corpus benchmark](../../../../benchmarks/session-corpus/session-corpus.bench.ts) measures three Web Host endpoints over synthetic current-generation Zstandard corpora. No product implementation changes.

### Workload

On 2026-09-28, one developer's local DSH home held 1,650 Sessions in 88 project directories. Aggregate counts were extracted from the newest generation of each Session; no content, identity, or path left that machine. [corpus-shape.ts](../../../../benchmarks/session-corpus/corpus-shape.ts) records 22 upper-quantile anchors for three dimensions: logical events (compact delta rows expanded), decompressed bytes, and turns.

| Quantile | Events | Logical bytes | Turns |
|---|---:|---:|---:|
| p50 | 53 | 86,195 | 1 |
| p90 | 709 | 1,849,503 | 3 |
| p99 | 7,229 | 8,479,554 | 18 |
| max | 84,467 | 48,139,877 | 2,181 |

Rank `r` of an `n`-Session corpus takes the first anchor at or above quantile `(r + 1) / n`, so every quantile of the synthetic corpus is at least the measured one. All dimensions share the rank: a long Session is long in every dimension. At 1,000 Sessions this upper-step sampling adds 16% events and 14% bytes over the measured quantile function; coarser anchors added up to 40%.

Other measured aggregates also set the fixture: 19 Sessions per project directory, one subagent child per six Sessions (measured 288 of 1,650), a 20,000-character system prompt (the measured median largest event is 21.9 KB), 3.9 characters per streamed delta, and 1.6 events per Zstandard frame. Turns contain tool steps (assistant message, tool call, tool result) until the event target is reached; a secant search over payload characters then reaches the byte target from below. Text comes from a Zipf-distributed synthetic vocabulary. Its stored compression ratio is 2.8, below the measured 3.4, so the fixture stores more compressed bytes than the source corpus.

### Corpus construction

Two preparation processes, one per CPU of a standard hosted runner, split the anchors into byte-balanced groups. Each authors one event body per anchor, compresses it once, and saves it with the anchor's projection record. A seed process then writes each Session as its own header frame followed by its anchor's body. Frame compression and file writes run eight at a time: each pending compression holds a native Zstandard context, and unbounded compression peaked at 7.7 GB RSS, more than a standard hosted runner provides. Sessions sharing an anchor differ only in header identity, creation time, project directory, and parent link. Creation time is a fixed permutation of rank. List order follows each body's last prompt time, which Sessions sharing an anchor share; it does not affect list cost. Events carry the fields that `Session.append` records, compact streams come from the production `AssistantStreamAccumulator`, and rows are encoded with the persistence package's `eventLines`. Before saving, each preparation process replays its authored bodies through `Session.create`, as `sessionQuery.readSession` does.

The projection cache is part of the list endpoint: each cold row carries cached projection values. Preparation folds each anchor once through the public `sessionProjectionCache.coldSnapshot` write-back. The seed then writes per-record documents for every Session with `serializeRecord`, rebinding identity to each header. Writing through the domain API costs one fsync per record, which took 89 s for 10,000 Sessions. The list worker requires every returned row to carry projections, so a storage layout change fails the benchmark instead of silently removing that work.

### Measured endpoints

Workers are compiled plain-Node processes, each started fresh against a seeded root. They compose the production Session store, projection registry, JSONL persistence, SQLite Session query with `openAt: first-search` on an in-memory index, JSON storage and projection cache, the Web projection set, AgentLoop, and the real `SessionController`. Transport lookups, upload registration, default model selection, and the Workspace registry are inert providers, because no measured path depends on them.

| Case | Corpus | Samples | Endpoint |
|---|---|---:|---|
| List | 3,000 | 3 | Host boot; first `session.list`; repeated `session.list` in the same process |
| Content search | 1,000 | 1 | First `session.search`, including the index build; a second query with a different term |
| Fork | 1,000, separate root | 3, then 1 | `session.fork` return for rank midpoints of ten equal length strata and rank 988; then rank 999 once |

The file must finish within five minutes on standard hosted CI, including seeding, and its last case asserts that limit. Search over 1,000 Sessions and one fork of the longest Session take about 170 s of it, so each has one sample. The list corpus is the largest that fits the remainder. Budgets enforce medians of list boot, first, and repeat, and of the fork median over strata and rank 990; search and the longest fork enforce their single samples. Search and fork use separate 1,000-Session roots, so fork children never reach the search index. Rank 988 is the highest top-level rank at the measured p99 (7,229 events); forking a subagent child adds a lineage lookup, and rank 990 already falls in the 99.3% anchor. Peak RSS of the list, search, and fork processes has a budget with the shared 1.25 headroom and no time scale. Each child's deadline equals the file limit, and each test's deadline outlasts its sequential children, so a failed case reaps every child before the scratch root is removed.

## Calibration evidence

Budgets use standard two-CPU hosted CI expectations (Linux x64, Node 24.21, PR #5403), rounded above the higher recorded median across the AMD EPYC 7763 and EPYC 9V74 runners and multiplied by the shared 1.25 headroom. Samples varied by up to 15% within one run; the runner models differed by up to 25% per endpoint. The hosted-to-reference ratio is 2.4 to 3.4, above the shared reference scale of 2, so reference-machine scaling would reject ordinary hosted runs.

| Endpoint (7763 / 9V74) | Hosted medians | Expectation | Budget |
|---|---|---:|---:|
| List 3,000: boot | 2,317.8 / 2,204.5 ms | 2,400 ms | 3,000 ms |
| List 3,000: first | 3,228.7 / 2,633.6 ms | 3,300 ms | 4,125 ms |
| List 3,000: repeat | 2,636.4 / 2,235.1 ms | 2,700 ms | 3,375 ms |
| Search 1,000: first (one sample) | 144,359 / 135,065 ms | 145,000 ms | 181,250 ms |
| Search 1,000: repeat (one sample) | 3,426.3 / 2,704 ms | 3,500 ms | 4,375 ms |
| Fork: strata median | 95.5 / 73.5 ms | 100 ms | 125 ms |
| Fork: p99, rank 988 (7763 only) | 1,066.2 ms | 1,100 ms | 1,375 ms |
| Fork: longest (one sample) | 19,162.1 / 20,326.7 ms | 20,400 ms | 25,500 ms |
| Peak RSS: list / search / fork | 742.7 / 1,197.8 / 745.1 MB (higher model) | 750 / 1,200 / 750 MB | 938 / 1,500 / 938 MB |

With seeding in one process, the complete file took 294.5 s on the EPYC 7763 runner (85 s seeding, 26 s listing, 149 s searching, 34 s forking) and 266.6 s on the 9V74. With parallel preparation it took 276.8 s on the 7763: the two preparation processes took 59 s and 65 s, because they share two CPUs with Zstandard and garbage-collection threads, and writing the corpora took 4.6 s. The other cases varied by less than 3% between runs on one runner model. Each additional 1,000 listed Sessions costs about 9 s, so a larger list corpus would leave less than a tenth of the limit for runner variation.

On Apple M5 Pro with Node 26.5, isolated runs measured list 1,000 at 311–358 ms first, list 5,000 at 1,364–1,603 ms first, search at 57 s first, and fork of the longest Session at 6.0–6.4 s. A 10,000-Session list took 3.2–5.4 s for the first call with 1.9 GB peak RSS.

## Alternatives considered

- **Sanitized copies of real Sessions.** Rejected: benchmarks never use recorded user material.
- **Authoring every Session through `Session.append`.** Rejected: per-append validation and freezing, repeated per Session, made seeding take minutes.
- **Omitting the projection cache.** Rejected: rows would lack the values the Web list shows, which understates list work.
- **A separate CI job.** Rejected: benchmarks share one idle standard runner. This file is limited to five minutes, and the job timeout rises from 15 to 20 minutes.
- **Listing 5,000 Sessions with five samples, and two list sizes.** Rejected: with the other cases the file took 6.6 minutes on standard hosted CI.

## Consequences

The gate covers corpus-scale list, search, and fork costs that single-Session gates cannot see. On standard hosted CI it already shows that content search spends 139 s building its index on first use, that the first list took 5.1 s at 5,000 Sessions in calibration, and that forking the longest Session takes 17.5 to 20.3 s. Seeding writes about 1.5 GB.

Exclusions: the corpus is current-generation only, although most real Sessions are stored in older generations, which list revision hashing and migration-on-read would add. Only 22 distinct bodies exist, so search indexes repeated text. Fork runs without Agent presets or Workspace attachment. Calls are in-process, without Typert transport or a browser. Filesystem caches are not evicted, so cold means a fresh process, not cold storage.
