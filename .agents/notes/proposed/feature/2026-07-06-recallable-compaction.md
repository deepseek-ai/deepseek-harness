# Agent Note: Recallable compaction — index checkpoints, a state checkpoint, and in-session history recall

Status: proposed

English | [中文](2026-07-06-recallable-compaction.zh.md)

## Problem

Compaction is irreversible from the model's current context. The summary the model sees carries no reference to what it shadows — `shadowedRange` lives only on the log-only `compaction/summary` event — and no tool lets the model read a shadowed span back. Whatever the summarizer drops is unavailable to the model, even though the append-only log holds every byte. Repeated compaction compounds this: the head checkpoint is rewritten every pass, so the request prefix takes a full prompt-cache miss each time, and earlier summaries are re-summarized generation after generation.

The root cause is one artifact playing two conflicting roles. An **index** wants to be frozen, chronological, and cheap; the model's **working memory** wants a global view, re-prioritization, and mutability. A single summary can be neither well.

No mainstream coding harness gives the model in-loop recall, and none of the surveyed implementations makes compaction prefix-cache-aware. An event-sourced session — originals durable, seq-addressable, replay-exact — is the natural substrate for both.

## Proposal

Split the checkpoint into two classes and make shadowed history reachable.

### Frozen index checkpoints

Newly stale history splits into chunks by deterministic policy: accumulate toward `chunkTokens`, snap edges with `toolPairingBalancedBefore` / `toolPairingBalancedAfter`, prefer turn boundaries, and place the final boundary as close to the retain boundary as balance allows, so the trailing slice shrinks to roughly one turn. Each chunk is compacted by one `compactRegion` call into an **index stub** (`stubTokens`, ~100–200 tokens):

- two or three lines of what happened;
- a keyword line of low-frequency literal anchors — exact error strings, values, config keys — grouped by kind;
- a code-composed footer: `[checkpoint c<summarySeq>: shadows conversation span #<start>–#<end>; originals retrievable via history_read]`. Code assembles these pointers from the `compaction/summary` seq and `shadowedRange`; the model never writes them.

A committed stub is never rewritten and never re-enters a later compaction region. A stub call's input is layered: the fixed preamble and the byte-identical pass-start state checkpoint (the shared prefix across all calls in the phase), then the keyword lines of all previously committed stubs — so a new entry indexes what is distinctive to its chunk instead of repeating the directory — the one or two most recent committed stubs for chronological continuity, and the slice itself. Sibling stubs from the same pass are not inputs (the concurrent phase forbids it; turn-aligned boundaries carry local continuity instead), and the state checkpoint is background only, never material to summarize into the stub. A slice consisting of recalled content is stubbed by code alone — a pointer line, no LLM call. A failed stub call degrades the same way: its slice gets a code-only pointer stub and the pass continues, making the state rewrite the only hard LLM dependency in a pass.

### The state checkpoint

One mutable working-memory document (at most one; zero before the first pass), positioned after all stubs and before the retained tail. Each pass rewrites it from the previous state plus this pass's staled content — O(previous + new), under the merge-don't-restate rule already in the summarization prompt — covering decisions, current state, constraints, and next steps. It carries its own footer and a size cap at the scale of the existing summary.

An inflation guard bounds the whole pass: if the post-compaction size is not strictly below the pre-compaction size, nothing commits and the turn proceeds; the attempt defers until more stale history accumulates. The guard compares one metric on both sides — provider-reported usage from the request path, falling back to the character estimator on both sides.

### Pass execution

- Chunk slices are surface position ranges. A pass runs two phases: all summarize calls execute concurrently, buffered off-surface; then regions commit strictly left to right — chunks first, trailing slice last — so the state checkpoint lands after every stub through contiguous single-node replaces. Wall-clock stays near one summarize call.
- The superseded state checkpoint folds into the next pass's first chunk as ordinary history: no tombstone, no new primitive. Its stub omits it, `history_read` renders it labeled `[prior state checkpoint]`, and its footer travels with the rendered text, keeping every trailing slice reachable through the two-hop chain.
- Range selection is frozen-aware: the compactable span begins after the last committed index checkpoint, at the surface head only when none exists. A legacy session's existing head checkpoint is adopted as state-class — its text the merge base, its node folded like any superseded state.
- A crash in the summarize phase commits nothing; a crash mid-commit leaves a left-to-right prefix committed, and the resumed pass reads its merge base from the log's latest state-class `compaction/summary` event and commits the remaining regions unconditionally — restoring `[stubs…][state][tail]` outranks shrinking.

### The recall tools

A new package `@deepseek-ai/dsh-tool-recall` (consumer-only, over the `dsh-session` and `dsh-compaction` vocabularies) registers two model-facing tools:

- `history_read(checkpoint, offset?)` — renders the shadowed span of any checkpoint in the log, including superseded ones, as `User:`/`Assistant:`/`Tool result:` transcript, paginated by a configured budget with a continuation cursor.
- `history_search(query, checkpoint?, limit?)` — case-insensitive literal scan over every shadowed span; returns snippets with checkpoint ids and coverage metadata (`scanned`/`matched`/`truncated`). The zero-match hint notes the scan is literal and points at direct `history_read` of a plausible checkpoint.

Both read `exec.agent.session.snapshotEvents()` (the tool-todo access pattern; non-agent callers rejected), render only surface-type message events, and return ordinary `tool/result`s — recalled bytes land at the context tail, logged, so reconstructability holds with no special casing. There is no new storage and no sidecar index: the session log stores the content, `compaction/summary.shadowedRange` and `shadowedSeqs` identify what each checkpoint replaced, and the tools read both. The tool schemas and the package's one system-prompt section are static strings; checkpoint ids reach the model only through footers. The transcript renderer moves from `compaction-basic` into `dsh-session`, shared by summarizer and tools.

### Cache and cost

The request prefix after a pass is `[system][stubs…][state][tail]`. Frozen stubs are byte-stable across passes, so the miss begins at the token replacing the previous state checkpoint and stays O(new chunks + state + tail) — instead of the baseline's position-zero miss. Recall output lands at the tail, leaving the prefix untouched. Per-pass summarize input is roughly twice the baseline input plus an m·S background term, bounded by a `chunkTokens` floor (a small multiple of the state cap) and a validated `stubTokens`/`chunkTokens` ratio ceiling; a shared-prefix input layout (preamble, then the byte-identical pass-start state, slice content in the tail) lets sibling calls earn cached-rate rereads.

### Packaging

The design ships as a new backend `dsh-compact-recallable` on the existing `ctx.compaction` seam, enabled by default in the shipped example configs; `compaction-basic` remains as the reference implementation and the seam's design twin, in the pattern of the paired LLM adapters. The seam JSDoc's "at most one auto-generated checkpoint, always at the head" clause is relaxed to name both backend behaviors.

### Relation to in-flight work

- **Tool-result pruning** (the in-flight pruning service): its replacement nodes carry `sourceEventSeqs`; the same registry fold lists pruned results as recallable. Follow-up scope; neither blocks the other.
- **Provider-usage token accounting** (the in-flight move of compaction pressure onto provider-reported usage): supplies the guard's accounting; the implementation stacks after it.
- **"Query sessions" backlog item**: the cross-session generalization; this Agent Note scopes to the live session with tool names and rendering chosen so that work extends rather than collides.
- **Training**: when to recall is a learned behavior. The deterministic footers and keyword anchors give training a stable target, and recall usage is fully visible in the session log for trajectory export; benchmark and RL design proceed with the post-training side.

### Follow-ups

Deferred until observation calls for them:

- Guard degradation ladder (code-only rollup of the oldest stub prefix, footers preserved, rolled-up ids remain recall targets; then one summary after the frozen boundary) — on observed guard livelock or stub-region pressure.
- Echo detection on stub outputs (sentence-scale n-grams, short literals exempt, retry then strip) — on observed division-of-labor leakage.
- Periodic state refresh from chunk originals — on observed drift in the handoff probe.
- `stateFallbackThreshold` (full-detail state prompt below a stub count) — on short-session regression.
- Lazy registration of the recall tools — on measured context tax in never-compacting sessions.
- Amortized stub drafting at pre-step: as soon as stale-but-uncompacted content accumulates past `chunkTokens`, draft that chunk's stub at the next pre-step (a log-only draft event, written while the chunk's surrounding context is still live) and let the compaction pass commit drafts instead of summarizing in bulk — the deterministic, replay-exact equivalent of background compaction (the Claude Code session-memory pattern; OpenClaw demonstrates the synchronous semantics are identical). Trigger: observed pass latency, or stub-quality gains from drafting near-live proving out.
- Split summarizer models; model-chosen chunk boundaries; cross-session recall; semantic search fallback — each behind its own evidence.
- Richer `history_search` query forms — regex, and structured queries over logged JSON tool results (sql/jq-style, or agent-authored queries against an indexed store) — on demand from observed search misses; literal matching ships first because the recall path stays a pure function of the log.

## Alternatives considered

- **Staged delivery** (ship recall tools alone over the existing backend; gate the checkpoint split on observed recall usage) — rejected: untrained models under-use any new tool, so the gate would measure training absence rather than design value, while the training side needs the complete mechanism to build environments against; the pre-release window is when persisted-format changes are cheapest; and the cache economics are first-party knowledge, not a hypothesis awaiting telemetry. The mechanism still introduces the recall tools before the checkpoint split; that is construction order, not a decision gate.
- **All-frozen full-size summaries, no state checkpoint** — rejected: unbounded permanent-prefix growth, self-accelerating toward thrashing, with nothing left to re-prioritize.
- **Pure stubs, no state checkpoint** — rejected: presumes the model knows what it is missing; fails on unknown unknowns.
- **LLM aging/consolidation of frozen chunks** — rejected as a routine mechanism: summary-of-summary loss and frozen-prefix churn; the code-only rollup is its surviving form, deferred.
- **Full prefix as chunk-summarizer input** — rejected: O(N²); the state document gives the same background at O(state).
- **One summarize call emitting all outputs** — rejected: the summarize path has no structured-output enforcement; parsing one free-text response apart is the fragile boundary the fail-closed design avoids.
- **Model-chosen chunk boundaries** — deferred: parse-and-validate cost against unproven value; chunk policy sits behind config.
- **Model-authored pointers** — rejected: pointers must be exact; deterministic assembly is.
- **FTS/vector index sidecar** — rejected in-session: the live log is in memory and bounded, a literal scan under budget suffices; an index earns its keep at cross-session scope.
- **Semantic search fallback / secondary-model extraction in the recall path** — rejected: an LLM or embedding call there breaks keyless replay determinism; recall stays a pure function of the log.
- **Raw events instead of rendered transcript** — rejected: leaks log-only vocabulary and chunk noise; the model reads what a model once saw.
- **Doing nothing (resume/fork as recovery)** — rejected: it makes recovery a human act.

## Acceptance criteria

- Auto-compaction over a long session yields `[stubs…][state][tail]` after every completed pass; prior stubs stay byte-identical across passes; committed stubs never fall inside a later region; the superseded state checkpoint folds without a tombstone, renders labeled, and stays reachable and searchable through the two-hop chain.
- Every checkpoint's surface text ends with the deterministic footer; footers round-trip through replay byte-identically; the state checkpoint's `shadowedRange` records its wider input range.
- Nothing commits before all summaries exist and the guard passes on like-for-like accounting; a guard failure commits nothing and does not fail the turn; a mid-commit kill resumed at the next pre-step completes the pass with the state region committed unconditionally, merge base read from the log; a legacy head checkpoint is adopted as state-class.
- `history_read` renders any logged checkpoint's span under budget with a working cursor; `history_search` covers every shadowed span with checkpoint-id snippets and coverage metadata, asserted in particular by finding content that exists only in a span shadowed by a superseded state checkpoint — the regression pin for trailing-slice reachability; both reject non-agent callers and never-existing ids or orphaned `compaction/start` with typed errors; recalled content appears as ordinary `tool/result`s; request-reconstruction invariants pass over sessions with compaction plus recall; one keyless snapshot scenario covers compact-then-recall end to end; tool schemas and the prompt section are byte-identical across passes.
- On the long-horizon bench suite: task success does not regress against `compaction-basic` at equal budgets; a handoff-fidelity probe (restate K known decisions and constraints after a pass) scores no worse; recall usage frequency and hit usefulness are reported per run via the dsh bench report pipeline, alongside the stub-directory attention measurement and cache-hit telemetry.
- Seam JSDoc, the compaction capability-seam Agent Note, `architecture.md`, and the generated tool, config, persistence, and module-graph catalogs update in the same change; all budgets live in config; new source directories hold per-file 100% coverage with HMR disposal tests.

## Risks

- **Recall is a learned behavior**: untrained models will under-use it, and the bench report exists to track the gap while training closes it. Until then the state checkpoint keeps the floor at the existing summary quality.
- **Unknown unknowns remain**: a detail absent from summaries and keywords draws no recall. Recall converts "unreachable even when suspected" into "reachable when suspected".
- **The stub directory occupies attention**: dozens of stable index cards per request may dilute focus; the bench measurement in the acceptance criteria tracks it against `compaction-basic`.
- **Cost**: per-pass summarize input is roughly twice the baseline input; short sessions sit near the baseline cost and quality, and the design pays off with session length.
- **State drift and division-of-labor leakage** are observable through the handoff probe and stub review; their counters are specified follow-ups.
- **Two backends** are a maintenance burden; the seam contract and the shared recall consumer bound it, and the bench comparison decides the default over time.
