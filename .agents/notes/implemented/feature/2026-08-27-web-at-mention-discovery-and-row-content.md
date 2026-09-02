# Agent Note: Web @ mention discovery cost and row content

Status: implemented

English | [中文](2026-08-27-web-at-mention-discovery-and-row-content.zh.md)

## Problem

Typing after `@` in the Web composer was slow, and the menu it filled was padded with text that distinguished nothing. Three defects sat behind that, all reachable from one keystroke.

Session discovery read every persisted session's whole log. `listCandidates` sliced to the candidate limit only for an empty query; a non-empty one called `readTitleSnapshots` over the entire corpus, and folding a title there costs one full log read per session. `DEFAULT_PREPARED_SESSION_CACHE_SIZE` is 5, so any real corpus evicts faster than it fills and every keystroke pays the cold price again. Measured against a 342-session store: 1139 ms of multi-frame zstd decompression and JSON parsing per keystroke, at concurrency 4 with a warm page cache. That is the shape users reported — `@` alone was tolerable at roughly 160 ms because it sliced first; one typed character was not.

The file index was truncating half of a workspace. `WorkspaceFileSearch` fills breadth-first under `maxEntries`, so a cap reached at depth four or five drops everything deeper. This repository holds 19 764 entries against a 10 000 cap, of which 8 148 (41%) were `lib/` build output that the two default exclusions (`.git`, `node_modules`) did not cover. `@AssistantMarkdown` returned nothing for a file that exists; `@MenuView` returned its spec file and not `MenuView.tsx`. Separately, any `tool/result` invalidated the whole index, so a read-only tool put a full traversal in front of the next caret.

Row content repeated itself. A workspace-root file rendered `reference.txt reference.txt`, because the description was the full path and the name was its basename. A session row rendered its title, its full session id, its full cwd, and a raw `toISOString()` timestamp. A drilled directory listing had no way back except deleting characters, and every row in it named the same parent.

Web e2e could not see any of this: its scaffold pins an isolated `DSH_HOME` holding two sessions.

## Decision

**A discovery label is a projection read, never a log read.** `SessionReferenceResolver` asks each listed session's projections for its title and takes its id when none answers. Attachment is decided by the session store at read time, not by the listing that produced the record, so a session that attached in between is never answered from a checkpoint its live log has moved past. An attached session answers from `ctx.sessionProjections.snapshot(session, ['title'])` — the live cut, which advances with every committed event, over events already in memory. A cold one answers from `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])`, the durable checkpoint written when it went cold. Both are synchronous and touch no log.

Folding a title from a log costs the whole log, and this call sits under every keystroke of `@` completion, so it is not attempted at all. A session no projection answers for — one persisted before the cache was composed, or seeded straight to disk — is labeled by its id and cannot be found by its title. That state is self-healing: opening the session once attaches it, and disposal checkpoints it.

**An invalidated file index keeps answering while its replacement builds.** `invalidate()` bumps a counter instead of discarding the traversal. A bare query serves the settled entries and starts a background rebuild that swaps in atomically; only a workspace's first bare query ever waits. A traversal whose root is unreadable rejects rather than settling: an unreadable branch costs its own candidates, but an unreadable root learned nothing, and publishing that as an empty index would replace entries that are still good and leave no invalidation to retry from. A failed refresh leaves the stale entries and the counter behind, so the next query retries. `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` grows from two names to fifteen — version-control and dependency stores plus build-output basenames no ecosystem also uses for sources — and `DEFAULT_FILE_SEARCH_MAX_ENTRIES` rises to 50 000. Both remain `excludedDirectories` and `maxEntries` config fields a deployment overrides.

**Rows carry only what distinguishes them.** A file names its parent directory and nothing at the workspace root. A drilled directory listing names no parent, because its breadcrumb does. A session names its workspace only when `SessionReferenceCandidate.sameWorkspace` is false — the host computes that, since it already holds both working directories for ranking — and is dated from the Host session list's `updatedAt` through the relative-time bucket that list uses, so one session reads the same age on both surfaces. A session the list does not carry falls back to the candidate's `createdAt`. `relativeTime` moves from `ui-workspace`'s `tree.ts` to `ui-primitives`; the words stay in each plugin's own dictionary, per locale-owned copy. The session id leaves the row: it is already the label a session without a title falls back to.

**A drill publishes a breadcrumb; typing a path does not.** `InputTriggerSource` gains an optional synchronous `header(session, req)` hook returning crumbs, re-polled on every hit with the live query and a pipeline-owned `drilled` flag. The flag is set only when the drill's edit actually reached the draft — a refused edit leaves it clear, so a header never names a directory nobody descended into — and it survives further typing until the menu closes. `CandidateRequest` carries the same flag. Crumbs ride their own snapshot store beside the menu store, so the frozen menu reducer stays unaware of them, and a crumb pick routes through `onPick` with `action: 'drill'` — returning to a step and descending into one are one outcome. `MenuView` renders the header above its scrolling viewport and moves `role="listbox"` onto that viewport, because a breadcrumb is not an option and a listbox may not carry one.

The zh composer placeholder says `文件或对话`, matching the `对话` section title the same menu already shows.

## Alternatives considered

**Fold the missing titles from their logs, memoized per cold log.** Implemented first, then removed in review. It made the first filtered query over a corpus the cache had not covered read those logs — on a 342-session store, roughly 190 of them — to rescue sessions that predate the cache. Correlating that store against the cache's arrival showed why the trade is bad: every session the product writes today gets a checkpoint at creation, `turn/end`, and disposal, and an old session acquires one the first time it is opened. The gap is legacy data that heals on contact, not a shape discovery has to pay for on every keystroke.

**Read a cold session's title through `sessionQuery.observeSession` or a persistence read handle.** Rejected: neither removes the read on the shipped backend. `observeSession` borrows the whole `inspection.events`, and `readFrom` documents that sequential media — JSONL, both encodings — "still parse the whole artifact and skip forward"; the primitive bounds what is returned and refolded, not the physical read.

**Debounce the candidate fetch.** Rejected. The reducer already resets every group to pending on each hit, so a trailing debounce extends the skeleton state and reads as *slower* while typing. With the fold removed, the round trip no longer justifies the timer; keeping the previous rows visible under a new generation is a separate decision with pick-safety consequences, and is not taken here.

**Read `.gitignore` to bound the index.** Rejected for now: it adds an ignore-file parser and a git dependency to a path that must stay synchronous and cheap. A basename list stays a config field a workspace overrides.

**Exclude `lib` by default with the other build outputs.** Rejected: Ruby gems and many npm packages keep their sources there, and the miss would be silent and total rather than the partial truncation this change removes. This repository builds into `lib` and adds it through `excludedDirectories`; the shipped default names only outputs no ecosystem also uses for sources.

**Read the session's last activity on the host, from the `sessionListMetadata` projection.** Rejected: that projection key is declared by `api-session-controller`, so reading it would make a `packages/context` capability depend on the BFF assembly — a direction with no precedent in this repository. The client already holds the same number in `ctx.sessions.list`, which is also what makes the two surfaces agree by construction rather than by coincidence.

**Let `MenuView` recognize the `@` trigger and draw the breadcrumb itself.** Rejected: `MenuView` is shared with `/`, and hardcoding file-reference semantics there crosses the package boundary the source registry exists to hold.

**Add a `drilled` flag to `CandidateRequest` as optional.** Rejected: the pipeline always knows it, and an optional field invites a source to read `undefined` as "not drilled" for a request that simply predates the field. Required, with every call site updated, matches the pre-release stance.

## Consequences

A deployment without `session-projection-cache` composed labels every cold session by its id; without `session-projections` too, every session. Discovery is as complete as the projections it reads, and never slower than them.

A store carrying sessions from before the cache shipped shows those sessions by id until each is opened once. On the machine this change was measured against that is roughly 190 of 342 — visible to a long-time user, invisible to a new one, and shrinking with use.

The file index is one invalidation stale: a bare query answered immediately after a tool result reflects the tree as of the previous traversal, and the following query sees the rebuild. Sources kept under an excluded basename need an `excludedDirectories` override.

`aria` goldens change shape: the listbox role now sits on an inner element, and rows carry a relative-time bucket that advances while a suite runs. `normalizeAria` collapses that vocabulary to `{{age}}` before the duration rules, anchored on an aria label's closing quote.

The reference row content is now derived from what the neighbouring chrome already shows — the breadcrumb for a drilled listing, the current workspace for a session. A future surface that renders these candidates without that chrome would show less than it should, and must ask the source for a different projection rather than re-deriving paths.

## Testing

Package tests cover a renamed attached session found by its new title while its checkpoint still holds the old one, a cold session labeled from its checkpoint, an unprojected session labeled by its id, a composition with no projection face at all, `readTitleSnapshots` never called on any of those paths, stale-while-revalidate driven through the real filesystem — a root that vanishes under a live index keeps answering and picks the workspace back up when it returns — an unreadable subtree costing only its own candidates, a `lib` tree that stays searchable, and the breadcrumb contract from both ends including a refused drill edit. `reference-composer.e2e.ts` covers the shipped composition: the refreshed menu golden shows the trimmed rows, and a new case drills into a folder, asserts the breadcrumb appears only then, and clicks the root crumb back to a bare `@`. Its seeded sessions appear there as ids, because a seed reaches disk as a log alone and this scaffold seeds after the host has already loaded its projection-cache table; seeding before boot would give the app a populated session list at startup, which the fresh-workspace flow four scenarios share does not expect. The titled paths stay in the package suite, and the e2e asserts the id labels it actually produces rather than a title the fixture cannot carry.

The 1139 ms figure is a measured floor for the server-side I/O against a real store, not an instrumented end-to-end UI latency; the web e2e scaffold's isolated `DSH_HOME` cannot reproduce the corpus that produces it.
