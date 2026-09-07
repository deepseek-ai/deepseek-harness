# Agent Note: Dependency swaps rejected by the 2026-07 NIH audit

Status: rejected — every swap below fails the net-simplification bar on evidence; recorded so the survey is not re-run from scratch

English | [中文](2026-07-26-dependency-swaps-rejected-by-nih-audit.zh.md)

## Problem

A repository-wide "Not Invented Here" audit (2026-07-26, ten parallel surveys covering every package group, scripts/, native/, vendor/ edges, python/, test infrastructure, and CI) asked of each hand-rolled surface: would a maintained external package or Node builtin delete it with a net win under the [dependency policy](../../implemented/process/2026-07-26-dependencies-over-hand-rolling.md)? The positive findings became their own proposed notes. The negative verdicts carry equal value — each names a plausible-looking swap whose hand-rolled shape is load-bearing — but would otherwise live only in a PR body. This note freezes them.

## Proposal

Adopt the following dependency swaps. Rejected — per-item evidence below; a future proposal for any item must beat its recorded reason, not just re-cite the policy.

**Protocol and parsing:**

- **`vscode-jsonrpc` for LSP base-protocol framing/correlation** (`lsp-stdio`): the swappable core is ~255 of ~1,800 src lines; the package cannot express the configured `maxMessageBytes` incoming-size bound (restoring it means rebuilding the deleted framing), inverts the cancel-grace teardown semantics (`raceAbort` rejects immediately then tears down; vscode-jsonrpc keeps the promise pending), errors on pre-header stdout banners real servers emit, and is CJS in an ESM-everywhere repo. The [LSP seam note](../../archived/architecture/2026-07-15-lsp-capability-seam.md) assigns JSON-RPC ownership to `dsh-lsp-stdio`; this audit is the explicit on-record weighing of the dependency it lacked.
- **`vscode-languageserver-types` for lsp-stdio's wire-type subset**: ~80 type lines and ~45 guard lines, but upstream guards differ in both directions (accept `uri: undefined` the repo must reject; require `targetRange` the repo tolerates absent), and the initialize-result shapes live in `vscode-languageserver-protocol`, dragging `vscode-jsonrpc` in as a runtime dep — ~1 MB for 80 spec-exact lines.
- **`json-rpc-2.0` for `dsh-sdk-jsonrpc-server`**: deletable correlation/dispatch is real (~100–130 lines) but the NDJSON wire must stay bit-identical for the hand-rolled Python SDK client, the package is single-maintainer, and the [archived GUI RPC note](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) already treats this package as a frozen narrow surface. `vscode-jsonrpc` is a worse fit still (Content-Length framing, cancellation vocabulary the protocol lacks).
- **`jsonrpcclient` for the Python SDK client**: v4 builds/parses messages only — ~20 lines — while the 500 lines that matter (subprocess lifecycle, threaded reader, id correlation, bidirectional server-role responses) stay; the library is in low-maintenance mode.
- **`eventsource-parser` for apiproxy's `readSse`**: only ~15 lines of framing are deletable, both wire ends are in-repo so spec conformance is moot, and it would add a dep to a browser-safe package. (Contrast with the [archived llm-deepseek dependency decision](../../archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.md), where a real provider sits across the wire.)

**Retry, timers, async:**

- **`p-retry`/`exponential-backoff` for `llm-retry`**: wrong execution model — the plugin is a decision-returning waterfall listener and the agent loop owns re-execution from the durable log; there is no function to re-invoke, which is those libraries' entire API. Provider `Retry-After` override, budget from prior-failure codes, durable `llm/retry` events, and HMR-quiescent abort are all uncovered. [Bounded-recovery note](../../implemented/architecture/2026-06-21-bounded-llm-request-recovery.md) already rejected SDK-owned retries.
- **`p-timeout`/`AbortSignal.timeout` for `dsh-timeout`**: the builtin cannot be disarmed early and carries a generic `TimeoutError`, not the capability-coded `TimeoutReason` that distinguishes nested deadlines; `idleWatchdog`'s per-demand rearm has no equivalent. [Timeout-library note](../../implemented/architecture/2026-07-06-timeout-deadline-library.md) owns the design.
- **`p-limit`/`p-queue` for the agent-loop tool-call pool**: pool bookkeeping is ~25 lines; the substance (model-ordered commits, mid-group reclassification, exclusive barriers, abort-drain with synthetic durable results) is not a concurrency-limiter shape.
- **`p-queue`/`async-mutex` for per-key promise-chain serializers** (`fs-local`, `storage-domain`): 8–14-line serializers; the packages are strictly larger than the code they would delete.
- **`events.once` + `AbortSignal.timeout` for subagent-subprocess `exitsWithin`**: `events.once` rejects if `error` fires first, but the hand-roll deliberately ignores `error` (captured separately by the spawn-failure path); the swap changes teardown-race behavior in exactly the code whose semantics are teardown races.

**Data and validation:**

- **Ajv for the tools JSON Schema validator**: the [schema-DSL note](../../implemented/architecture/2026-07-20-unified-json-value-schema-dsl.md) explicitly rejected accepting a larger schema language; the validator also does realm-intrinsic prototype checks Ajv does not.
- **`structuredClone` for session `snapshotJsonValue`/`isJsonValue`**: it is a validator + detacher enforcing the lossless-JSON boundary with single-read-per-getter and cross-realm intrinsic checks; `structuredClone` accepts Map/Date/-0 and enforces nothing. Same for the deliberately dependency-free `code-runtime-worker` mirror hardened against a model-mutated realm.
- **`fast-deep-equal` for session surface `isDeepEqualJson`** and **`safe-stable-stringify` for repeat-tool-reminder canonicalization**: both swaps work mechanically but each trades ~17–20 commented, tested lines for the first external runtime dependency of a core package — negative net at this size.
- **zod/valibot for durable-event strict decoders** (goal fold, tool-ralph, session): exact-key fail-loud decoders at durable boundaries with event-specific messages; a second schema library beside repo-standard schemastery is a policy change, not a deletion.
- **`gpt-tokenizer`/tiktoken for token-meter**: the [replay-token-meter note](../../archived/architecture/2026-07-15-replay-token-meter-service.md) explicitly rejected tokenizer backends; a GPT BPE is also the wrong tokenizer for DeepSeek models, and ~350 of the package's lines are replay-fold bookkeeping no tokenizer covers.
- **`partial-json` for streamed tool-call arguments**: nothing to replace — arguments stay raw JSON strings end-to-end by documented contract; `JSON.parse` runs only on complete payloads.

**Filesystem, subprocess, terminal:**

- **`write-file-atomic` for fs-local/storage-json atomic writes**: the packages lack the private 0700 staging dir, Win32 DACL copy/`ReplaceFileW`, AbortSignal support, and parent-dir fsync — each the point of the hand-roll. The koffi Win32 bindings themselves are justified by the [Windows durable-publish note](../../implemented/architecture/2026-07-05-windows-jsonl-durable-publish.md).
- **`fzstd`/native zstd packages for JSONL frame scanning**: `node:zlib`'s builtin zstd already does the compression ([zstd note](../../implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md), which explicitly rejected an external native dependency); the remaining `scanZstdFrames` locates RFC 8878 frame boundaries *without decompressing* for torn-tail repair, which no package exposes.
- **`picomatch`/`tinyglobby`/`ignore` for fs search**: no glob engine exists — both discovery tools shell out to ripgrep per the [bash-backed discovery note](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md).
- **`istextorbinary`/`chardet` for text detection**: the hand-roll is a ~15-line NUL-sample plus fatal `TextDecoder`; heuristic packages are larger and would change which files the model can read (model-visible `FS_NOT_TEXT` drift).
- **`shell-quote` for POSIX single-quoting**: two 1-line quoting helpers with exhaustive tests versus a maintenance-mode package with a CVE history and different escaping output — a safety boundary is the wrong place to save one line.
- **`strip-ansi` for pty sanitization**: the pty sanitizer is a streaming state machine with split-sequence carry across chunks and OSC `133;D` prompt-marker extraction (the shell-readiness signal); stateless strippers replace ~20 inner lines while all state machinery stays. `stripVTControlCharacters` also demonstrably leaks unterminated-OSC payloads the session-title normalizer must strip (anti-spoofing).
- **`pidtree`/`ps-tree` for the pty process inspector**: bare PID trees; the code needs start-time identity against PID reuse plus `/proc` stdin-wait detection no package does.
- **`execa` for the subagent-subprocess dispose ladder**: `forceKillAfterDelay` covers SIGTERM→SIGKILL but not the stdin-EOF-first cooperative tier or the reject-if-no-exit-edge contract; adopting it here rewrites spawn sites while keeping the ladder. (Test-infrastructure spawn plumbing is different — see the [archived execa test-infrastructure decision](../../archived/testing/2026-07-26-execa-for-test-subprocess-plumbing.md).)
- **`tree-kill` for acp-snapshot teardown and lsp process kill**: the lines are drain-ordering/error-propagation, not tree traversal; lsp/bash already use detached process groups + taskkill.
- **node-pty everywhere for the TUI test driver**: the archived [Windows-TUI note](../../archived/feature/2026-07-20-windows-tui-support.md) explicitly rejected node-pty-on-every-host; it was already the Windows leg.

**Servers and HTTP:**

- **`msw` for llm-mock-server**: the server exists to fault the wire — socket destroy, mid-SSE disconnect, stall, pre-listen refusal — for real HTTP adapters and subprocesses; in-process interception can express none of that. [llm-mock-server README](../../../../packages/test-support/llm-mock-server/README.md) owns the design.
- **`hono`/`sirv` for host/webserver**: the core is a disposer-based dynamic route registry (registrations-are-effects contract, HMR unregistration) plus index-HTML transform taps; hono routers are add-only, and static middleware cannot serve the transformed index. ~244 lines total, genuinely small.
- **`@mozilla/readability`/`iconv-lite` for web-fetch-http**: the provider returns raw HTML; charset handling is already the builtin `TextDecoder`; MIME parsing is ~11 lines; redirect following is same-origin security policy.

**SQLite and storage:**

- **`better-sqlite3` for the three SQLite backends**: all use builtin `node:sqlite`, intentional twice over — it gates the [Node engine floor](../../implemented/process/2026-07-06-node-engine-floor.md) and works inside the single-file executable where a native addon would complicate packaging. No hand-rolled migrations or busy-retry loops exist.

**Repo tooling:**

- **`wireit` for `run-gates.ts`**: could express the `needs:` graph, but allowFailure observational legs and mode-specific concurrency caps have no equivalent, caching must be defensively disabled for a correctness gate runner, and every CI workflow invocation would restructure. The [parallel-gates note](../../implemented/process/2026-07-06-parallel-pre-push-gates.md) accepts a custom scheduler as the cost; keep is defensible.
- **`@arethetypeswrong/cli` for `verify-node-next-types`**: attw is per-package (100+ invocations vs one fast whole-workspace compile) and does not check the repo-specific explicit-`.ts`-specifier invariant, so the scan half stays regardless. Recorded as considered; keep the script.
- **`syncpack`/`manypkg` for `check-workspace-constraints.ts`**: they cover ~20 lines of range alignment; the load-bearing 200+ lines (computed `files` lists, cordis peer=dev pairing, hierarchy shape) are repo policy no generic engine expresses.
- **`remark-validate-links` for `verify-md-links.ts`**: the gate rides the repo's shared mdast toolchain; adopting remark-cli adds a second markdown stack to delete one small file.
- **`prebuildify`/`node-gyp-build` for the landlock launcher packaging**: inapplicable — those load `.node` addons via dlopen; the launcher ships a standalone exec'd static binary, and per-platform `optionalDependencies` *is* the ecosystem convention for binaries.
- **Replacing the Landlock launcher itself with `@landstrip/landstrip`**: fails the security-invariant test — the launcher is a ~300-line reviewable C file whose binaries are byte-pinned to native CI builds and that already migrated away from a Rust dependency; a single-maintainer LGPL Rust binary set is a larger audit surface whose releases are harder to match to reviewed source. The [Windows ACL decision](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) records the same rejection for the shipped Windows rung.
- **`hatch-nodejs-version` for Python release versioning**: roughly LOC-neutral (a custom metadata hook replaces the regex), inverts the recorded decision that the dev sentinel never determines a release version, and puts a single-maintainer build plugin in the release supply chain.
- **YAML consolidation (`js-yaml` vs `yaml`)**: the repo carries both parsers, with the `!!js` tag defined four times on js-yaml (vendored include, app-boot, apps/cli, `scripts/verify-cordis-config.ts`) and twice on `yaml` (sdk-telemetry's `ScalarTag`, sdk-helper's comment-preserving Document editing). The direction is forced — js-yaml cannot replace `yaml` (sdk-helper needs the Document API) — but migrating the js-yaml sites cannot retire the library either (the vendored include pins it) and would put two parsers in charge of one dialect that must agree exactly, against the [personal-config note](../../archived/feature/2026-07-20-dsh-cli-personal-config.md)'s deliberate load-only-copy parity. Deletable: ~20–25 lines of duplicate tag definitions and two `@types/js-yaml` entries. The consolidation moment is a future include sync, not now.

## Alternatives considered

- **Record nothing and let the PR body carry the verdicts.** Rejected: PR bodies are not part of the maintained record, and the whole point of surveying is that the next audit starts from these verdicts instead of re-deriving them.
- **One rejected note per item.** Rejected: ~30 files of ceremony for verdicts that share one evidence standard and one fate; per-item notes are warranted only if an item is re-proposed with new evidence.
- **Fold each verdict into the implemented note that owns the seam.** Partially done — where an owning note already rejected the alternative (retry, token-meter, schema DSL, zstd, sandbox, node-pty), this note cites rather than duplicates it. The remaining items have no owning note, which is why they are recorded here.
