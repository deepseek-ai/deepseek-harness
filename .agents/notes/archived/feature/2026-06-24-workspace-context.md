# Agent Note: Workspace context instruction files

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-24-workspace-context.zh.md)

## Problem

Repository guidance such as `AGENTS.md` belongs in a coding session's effective context so project conventions, build commands, and review rules arrive without repeated user pasting. The stdio and ACP products need the same behavior, isolated by session cwd: a global system-prompt section leaks one workspace's files into another live ACP session.

Neighboring products establish useful conventions but differ in details. Codex treats `AGENTS.md` as native, Claude Code uses `CLAUDE.md` and familiar system-reminder-style user context, and opencode supports both names with one winner per directory plus lazy nested discovery. The harness needs cross-tool compatibility without loading duplicate or contradictory files from the same scope.

The lifecycle has two distinct classes of content. The initial applicable chain is injected once before the first request. Nested files, edits, candidate switches, and removals happen later and join the same durable append-only history.

## Decision

The implementation lives in `packages/context/agent-instructions` as `@deepseek-ai/dsh-agent-instructions`. It is a request-context extension, not a core service or a filesystem backend. The shared demo spine and Host Runtime mount it from an explicit `{ maxBytes } | false` deployment choice; `dsh web` enables a 65,536-byte budget while the Host Runtime's headless consumer disables it. The plugin consumes `agent/pre-step`, immutable `tools/result` outcomes, `session/event` boundaries, and the optional `ctx.fs` capability.

The plugin does not statically inject `fs`. Providerless product trees therefore boot normally and the plugin no-ops until a filesystem provider exists. All production reads go through that provider. Candidate probes resolve each path and stat the result, so a final-component symlink is followed to its target: a link to a regular file loads, while a missing path or a non-file target is a confirmed absence. Following repository-owned links across the trust boundary is a deliberate reversal of the original no-follow probe; the [instruction-symlink follow note](2026-07-21-follow-instruction-symlinks.md) owns that decision and its residual risk. The step signal and dynamic tool execution signal propagate through resolution, metadata probes, and streaming reads, so cancellation does not wait for an unrelated filesystem scan. A resolve or stat exception is classified as unavailable: it skips only that candidate and is never interpreted as the deletion of an already-loaded scope.

### File Names And Precedence

The default per-directory candidate list is `['AGENTS.md', 'CLAUDE.md']`. The list is configurable as `instructionFileCandidates`, and `AGENTS.md` is an ordinary first candidate rather than a hidden priority. In one directory, only the first existing regular-file candidate loads. With defaults, `AGENTS.md` is native and `CLAUDE.md` is a compatibility fallback. A second list, `localInstructionFileCandidates` (default `['AGENTS.local.md', 'CLAUDE.local.md']`), loads an additive local overlay after the base file in the same directory; the [default local overlay](2026-07-21-local-instruction-overlay.md) owns that decision.

Candidate entries are same-directory file names. Empty entries, `.`/`..`, and entries containing `/` or `\` are ignored. Other same-directory names can be opted into explicitly; rule directories and import semantics are outside this contract.

The user-global file is fixed at `$DSH_HOME/AGENTS.md`, is not affected by either candidate list, and has no local overlay. `$DSH_HOME` defaults to `~/.dsh`, matching the harness-level home role of `~/.codex` or `~/.claude` rather than introducing a plugin-specific home. Tilde expansion and the default live in `dsh-home-paths` so future harness features share the same convention.

### Baseline Injection

At the first `agent/pre-step` of an agent-loop instance, the plugin composes one sourced user-role baseline. When the downstream decision enters a nonempty first-step batch, the plugin folds the baseline into that final batch right after the claimed prompt, so it becomes durable with the direct prompt and reaches the first request. Rejection or an empty first-step decision leaves the baseline in the next-step inbox for a later wakeup. The plugin loads the user-global file first, then finds the project root by walking upward from `agent.session.header.cwd` to a configured root marker (default `.git`), then loads the configured candidates from each directory from the root to the cwd. A `.git` file and a `.git` directory are both valid markers, covering linked worktrees and submodules. Without a marker, the cwd itself is the root.

The baseline becomes a durable `user/message` with a typed `agent-instructions` source. Its `baseline: true` marker distinguishes a complete baseline from later deltas, its `baselineIdentity` records normalized discovery, precedence, project-root, and budget semantics, and its change list persists the included scopes and content digests. If a previously queued workspace baseline is still pending, the plugin removes that exact message and prepends its replacement instead of accumulating duplicates.

A resumed agent creates a new loop instance over persisted history. At its first `agent/pre-step`, a visible baseline with the current identity remains authoritative while the plugin compares its retained scopes with a complete current rendering. Unchanged and budget-omitted files append nothing; offline additions, edits, removals, and files that leave the retained budget set append `set`, `replace`, or `remove` transitions in the entering batch without mutating or duplicating the original baseline. An incompatible visible baseline is superseded by one complete baseline in current precedence order with explicit replacement language; when no current candidate exists, an explicit empty baseline clears the earlier scopes. A hot plugin remount follows the same rule. If compaction has shadowed the typed baseline, the next entering pre-step composes one complete current baseline and carries it in the same request.

The baseline is a user-role `<system-reminder>` with `Instructions from: <path>` sections and explicit authority and precedence language. This familiar model-facing frame avoids a harness-specific XML vocabulary. Project paths are root-relative and the user-global path is `~/.dsh/AGENTS.md` for the default home or `$DSH_HOME/AGENTS.md` for a configured home. The final rendering boundary escapes a literal `</system-reminder>` anywhere in instruction content or model-visible path, scope, and budget metadata before byte accounting completes. The package README owns the exact current [prompt shape](../../../../packages/context/agent-instructions/README.md#prompt-shape).

### Dynamic Discovery And Refresh

After a successful first-party `read`, `write`, or `edit` call, the immutable `tools/result` observer reconciles the touched descendant chain and every scope already known to the session, then queues an `Additional instructions from: <path>` system-reminder in the agent inbox for the next request. Under PTC mode, successful sub-dispatch touches bubble through opaque parent execution tokens until the top-level result settles. A touch produced inside an agent-loop step does not begin its asynchronous projection until the durable `step/end`; a direct tool execution outside an open step projects immediately. The two boundaries keep result and step adjacency deterministic without making the tool pipeline await filesystem discovery.

A content edit appends `Updated instructions from: <path>`, states that the new content replaces the previous content, and includes the complete current file. If precedence changes from one candidate to another, the message also names the previous path and says it no longer applies. If no candidate remains, the plugin appends `Instructions removed: <path>` and states that the previously loaded instructions no longer apply.

Baseline and dynamic messages carry their complete system-reminder framing in `content`, and every sourced `user/message` reaches the model verbatim (there is no core wrapper to opt out of). The typed `agent-instructions` source carries persisted state that is never rendered to the model.

Shell commands are not discovery triggers. Local bash calls start fresh shells, and inferring reached paths from arbitrary command strings would require shell semantics the prompt plugin does not own.

### Duplicate Suppression And Change Detection

Every workspace context event stores versioned metadata with `{ action, scope, path, digest? }`, where `digest` is SHA-1 over the loaded content. Complete baselines additionally carry `baseline: true` and `baselineIdentity`. The model-facing prompt has no HTML comments, hidden markers, or headings that are parsed back into state.

At reconciliation time the plugin scans workspace-sourced `user/message` events and derives the latest state for each visible scope. Successful nested touches aggregate under their parent execution token, including when a later composite result is blocked; the top-level result transfers them either to the open session step or directly to a per-agent projection queue. A `step/end` releases its staged touches only after that boundary is durable, and the next `agent/pre-step` waits for the serialized projections. Each projection composes against visible history plus the current inbox and replaces the single pending workspace context instead of accumulating intermediate renderings.

An unchanged path and digest is suppressed. A logged removal is a tombstone, so a reappearing candidate becomes a new `set`. Resume works from persisted metadata: a compatible visible baseline supplies comparison state rather than causing another complete baseline to be appended. If compaction removes an instruction event from the visible surface, that state no longer suppresses a later load, matching the fact that the model can no longer see it. A change enters metadata or pending state only when its file-specific section retains at least one content byte, or when the original content is genuinely empty. Partial truncation commits the full-content digest once any byte survives; zero-content truncation remains eligible on a later touch. A baseline may retain budget diagnostics with no committed changes. A dynamic batch with no committed change is withheld entirely and retried on a later touch. An omitted file remains eligible on a later touch.

The initial baseline's typed changes are comparison state only while its event remains in the visible session surface. Resume retains a compatible baseline and reconciles current baseline and visible dynamic scopes, so changes made while the agent was offline append transitions before the first resumed request. When compaction shadows the baseline event, the next entering pre-step composes the complete current baseline and records it in the same request; a successful filesystem touch can instead re-add an unchanged baseline scope or append baseline edits or removals as dynamic messages. Neither path rewrites the original event. The in-memory scope marker and provider-version cache only select and accelerate probes, so neither can suppress context the model no longer sees.

There is intentionally no watcher. Detection occurs at the next successful structured filesystem touch, resumed-baseline reconciliation, or entering pre-step that restores a shadowed baseline. A provider failure produces no removal; absence is only accepted when all configured candidates in that scope were probed successfully.

### Byte Budget And Bounded Reads

`maxBytes` is required and applies separately to a rendered baseline or one dynamic reconciliation batch; there is no implicit or unbounded render budget. Non-positive and non-finite values disable loading. When content exceeds the budget, broader files are omitted before the most-specific file is truncated. A visible `Workspace instruction budget ...` notice names omitted and truncated paths and byte counts, and output never exceeds the configured bytes.

`maxSourceBytes` is a positive per-file cap with a 1 MiB default. The loader checks reported size before reading and still consumes content through `streamText()` with a running UTF-8 byte count, so missing/stale metadata cannot force an unbounded allocation. An oversized winning candidate is unavailable rather than a reason to fall through to another same-directory name. The plugin deliberately keeps no process-wide cache and never retains instruction prose. It keeps only `{ path, version, digest }` per effective scope in a `WeakMap<Session, Map<scope, state>>`: a matching provider `FsVersion` plus matching effective prompt state skips the read, while a changed version triggers a bounded read and SHA-1 confirmation. SHA-1 remains the cross-provider content identity persisted in visible structured metadata; provider versions are only an in-memory invalidation fast path. Dynamic cache transitions occur while a serialized projection composes the one desired inbox context, and the next pre-step waits for that projection before deciding what enters the request.

## Alternatives considered

**Use a global `ctx.systemPrompt.section()`.** Rejected because one Cordis context can host sessions with different cwd values, while repository-owned text is lower-authority context rather than top-authority provider system content.

**Always leave prepared workspace context in the inbox.** Rejected because context prepared during pre-step would then survive the current request and start a second model step by itself. The inbox remains the staging and rejection fallback, while an entering pre-step owns atomic delivery with its final batch.

**Load both `AGENTS.md` and `CLAUDE.md` in one directory.** Rejected because repositories in transition commonly duplicate guidance across both files. Ordered candidates make precedence explicit and configurable.

**Parse rendered headings or hidden comments to recover loaded state.** Rejected because instruction prose can contain the same text, causing silent false positives. Persisted JSON metadata provides an unambiguous state channel that is invisible to the model.

**Summarize files with a model.** Rejected because instruction files are already curated summaries; another model call is nondeterministic and can erase edge-case requirements. Deterministic full text with byte budgeting is simpler.

## Consequences

Workspace guidance is isolated per session and shared by the demo entry points, Web Host, and every tool presentation mode. Initial, nested, and changed instructions are durable and replayable. The generic session/agent context contract carries typed source data through inbox-staged and durably entered user messages without flattening entries.

Repository text remains untrusted input. Lower-authority user-role framing, explicit precedence language, and delimiter escaping reduce risk but do not eliminate prompt injection. Following a candidate symlink to its target widens that surface to off-tree content, so the permission and sandbox layers that confine `ctx.fs` to trusted roots are the boundary that treats workspace files as data rather than authority (the [instruction-symlink follow note](2026-07-21-follow-instruction-symlinks.md) owns the residual risk).

The system is event-driven rather than watch-driven. Edits are not visible at the exact filesystem mutation instant unless that mutation goes through a structured tool; externally changed files are noticed on the next successful structured touch, resume reconciliation, or restoration of a shadowed baseline. This keeps the design deterministic and provider-neutral.

## Deferred

Bash-derived path reporting, recursive startup scans, file watchers, lowercase defaults, `.claude/CLAUDE.md`, `.claude/rules/*.md`, import directives, ACP `additionalDirectories`, trust acknowledgements, and model-generated summaries are deferred. Project-directory `.local.` overlays now load by default (the [default local overlay](2026-07-21-local-instruction-overlay.md) owns that decision); a user-global overlay, directory rule systems, and imports still need their own precedence and trust designs.
