# Agent Note: Packaged ripgrep spawn for glob/grep

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-01-packaged-ripgrep-search.zh.md)

> Supersedes [bash-backed grep/glob discovery](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md): the v1 decision's explicitly deferred alternative — directly spawning ripgrep — is now what ships.

## Problem

The `glob`/`grep` tools ran through the bash executor seam, which made a system `rg` install a host dependency. On Windows and container images there is no `rg` on `PATH` by default, so the tools silently vanished there; a deployment could only discover that from the load-time probe warning. The bash seam also forced the whole model-visible argument surface through one shell-quoting helper, because a shell sat between the tool and ripgrep — the [bash-backed note](../../archived/feature/2026-07-09-bash-backed-grep-glob-discovery.md) recorded that coupling as the v1 trade-off and named direct spawn as the reasonable follow-up if the shell-string domain ever proved too sensitive. It did: every model value had to survive POSIX single-quoting, the probe had to be scripted in tests, and the executor's own timeout classification duplicated what the cooperative tool-timeout policy already owns.

## Decision

`@deepseek-ai/dsh-tool-fs-search` now runs the PACKAGED ripgrep binary (`@vscode/ripgrep`, an npm dependency whose optional platform packages ship the binary) through the `ctx.subprocess` seam: `runRipgrep()` spawns `rgPath` with a plain argv vector prefixed by `--no-config`, collect-mode stdout/stderr, `graceMs`, and `exec.signal` forwarded. `rgPath` resolves lazily at the first call (memoized per process): `@vscode/ripgrep` resolves its platform package at module evaluation, so a static import would turn a missing or corrupt platform package (`--omit=optional`, partial install) into a Loader-composition failure — the load-time failure mode this change exists to remove. There is no shell layer, so the shell-quoting boundary is gone from execution; the `singleQuote` helper and its shell-spawning tests are deleted with it. The raw streams request the seam's diagnostic-tail collect shape (no spill files — the tool never reads a raw spill path; a lossy stdout read fails as `SEARCH_RAW_OUTPUT_OVERFLOW`). The terminate grace and the stderr tail budget are validated `Config` fields (`graceMs` default 3000, `stderrMaxBytes` default 64 KiB), no longer inherited from bash-local's config. Registration is unconditional — the load-time `command -v rg` probe and the conditional registration decision are deleted, and with them the "rg not found" warning. The package injects `tools`, `systemPrompt`, and `subprocess`.

Exit semantics stay tool-owned: exit 0 is success with results, exit 1 is a successful empty search, anything else classifies into the existing `SEARCH_*` vocabulary (invalid pattern, launch failure, signal kill, raw-output overflow). Timeout is the cooperative tool-call budget attached to the tool definitions: `@deepseek-ai/dsh-tool-call-timeout-policy` aborts `exec.signal`, the subprocess seam's terminate escalation provides the hard kill, and the tool reports `SEARCH_ABORTED`. The working directory is the session header cwd when present, else `process.cwd()` — there is no executor config to default through anymore, so the tool owns the fallback.

The `fs-glob-sampling` ACP snapshot scenario now executes the real packaged binary against a prepared workspace whose fixed mtimes pin the `--sort=modified` order, replacing the PATH-injected `rg` stand-in (POSIX-only, because the displayed paths carry `/` separators the session-log comparison cannot normalize).

## Alternatives considered

**Keep the bash seam and probe, but document `rg` as a required host dependency.** Rejected: the host dependency is exactly the failure this change removes, and Windows support for the discovery tools was the point of the exercise; a documented requirement is still a requirement.

**Make `rgPath` injectable (a config field or env override) so tests and snapshots keep substituting a stand-in binary.** Rejected: it adds a public deployment surface whose only consumer would be test hooks, and the real binary is deterministic enough to pin directly through fixture mtimes — the packaged binary is the deployment, so tests should exercise it.

**Switch to a pure-JS glob/search engine (e.g. `picomatch`/`tinyglobby`).** Rejected: the [dependency-swaps audit](../../rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md) already rejected that on the "no glob engine exists" evidence; ripgrep semantics (`--sort=modified`, VCS pruning, JSON transport, regex dialect) are the tool contract.

## Consequences

- The discovery tools work on every platform the packaged binary covers (darwin/linux/win32, x64/arm64) with no host install; the shipped TUI/Web rosters gain `glob`/`grep` as fixed members ([even-out-shipped-tool-rosters](../feature/2026-07-31-even-out-shipped-tool-rosters.md)).
- The shell-string attack surface is gone: hostile patterns are inert argv elements, pinned by the integration suite, which now runs on Windows too (it previously self-skipped without a system `rg`).
- The spawn is unconfined (a plain `ctx.subprocess` call), so `--no-config` is prepended: a host `RIPGREP_CONFIG_PATH` (or an `rg.conf` beside the binary) can otherwise inject a `--pre` preprocessor that executes an arbitrary command for every matched file. With `--no-config`, no config file — and therefore no preprocessor — can reach the search.
- The raw-output overflow path changed shape: the old bash-backed route inherited bash-local's always-on spill and could leave an unread multi-megabyte temp file; the subprocess seam now collects without spill, and overflow is a pure error (`SEARCH_RAW_OUTPUT_OVERFLOW`, "narrow pattern, path, or include and retry") with zero content returned.
- Load-time failure modes changed: a broken subprocess seam now fails the first search call (`SEARCH_FAILED`) instead of failing plugin load through the probe; a missing binary is a launch failure with the packaged path, not a PATH problem.
- The integration suite's fixture dropped a filename Windows cannot represent (`"` in a name), keeping the suite replayable on every platform.
- Regenerating `THIRD_PARTY_NOTICES.md` surfaced a latent generator bug the new dependency made visible: Node's `fs.globSync` returns OS-native separators, so on Windows the `/`-suffixed dev-area prefixes in the notices tiering never matched and dev-only packages (test tooling, support leaves) were mis-tiered as runtime. The generator now normalizes manifest paths at ingestion, and the notices are platform-independent.
- The `@vscode/ripgrep` dependency adds its MIT row to the runtime tier, and pnpm 11's truncated virtual-store directory names needed a content-scan fallback in the notices generator's metadata lookup.
