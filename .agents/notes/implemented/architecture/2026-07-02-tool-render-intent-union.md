# Agent Note: Tagged render-intent union for tool-call presentation

Status: implemented

English | [中文](2026-07-02-tool-render-intent-union.zh.md)

> The render-intent union remains current for UI transports; its ACP mapping is superseded by [ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md).

## Problem

A tool declares how its calls render in a UI (an editor's tool-call card) through two callbacks, `presentCall`/`presentResult` on `ToolDefinition`, returning `ToolCallPresentation` / `ToolResultPresentation` with an optional `ToolTerminal` sub-shape. These grew incrementally into a **bag of optional fields**: `title`, `kind`, `rawInput`, `content`, `locations`, `terminal` on the call; `title`, `content`, `terminal` on the result; `cwd`/`output`/`exitCode`/`signal` on `ToolTerminal`. The split of responsibility is muddy:

- The call-side and result-side `terminal` fields overlap, and the bridge reconciles a `content` block AND a `terminal` block AND `rawInput` per call, stitching them together with ad-hoc conditionals.
- Which combinations are *valid* is unwritten: a `terminal` call that also sets `content` means "description above the card"; a generic call that sets `terminal` is meaningless but representable. The type permits nonsense.
- There is no way to express the one file-tool affordance an editor most wants — a **diff card** (`{path, oldText, newText}`, which Zed renders as an inline diff / new-file preview). `ToolCallPresentation.content` is the *LLM* `ContentBlock[]` vocabulary (text/image), so a tool literally cannot ask for a diff.

An earlier rejected collapse-tool-owned-presentation proposal deferred rich rendering until it could "return later as a tagged render-intent union after there are at least two real tools and two real consumers to validate the vocabulary." That bar is met by multiple producer families plus the TUI and host/client-runtime (Web) consumers.

## Decision

Replace the optional-field bag with a **`card`-tagged discriminated union**. A tool declares one render intent per call/result; the bridge switches on the tag.

```ts ignore-check
type FileLocation = { path: string; line?: number }
type FileDiff = { path: string; oldText: string | null; newText: string } // oldText null ⇒ new file

// presentCall → ToolCallView
type ToolCallView = GenericCallView | TerminalCallView | DiffCallView
interface GenericCallView { card: 'generic'; title: string; kind?: ToolCallKind; rawInput?: unknown; content?: ContentBlock[]; locations?: FileLocation[] }
interface TerminalCallView { card: 'terminal'; title: string; description?: string; cwd?: string }
interface DiffCallView { card: 'diff'; title: string; diffs: FileDiff[]; locations?: FileLocation[] }

// presentResult → ToolResultView
type ToolResultView = GenericResultView | TerminalResultView
interface GenericResultView { card: 'generic'; title?: string; content?: ContentBlock[] }
interface TerminalResultView { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
```

`card` is **required** on every variant — a real discriminant, not an optional default. The bridge does `switch (view.card) { case 'generic': … case 'terminal': … case 'diff': … default: assertNever(view) }`. The union is **closed** (per the [switch-exhaustiveness convention](../../../../AGENTS.md)): a fourth render intent (a table, a chart) needs new bridge code to render it anyway, so a plugin-added variant that the bridge silently drops would be worse than a compile error. Adding a variant breaks compilation at the bridge switch — exactly the signal we want.

### Why a tagged union beats the field-bag

- **Invalid states become unrepresentable.** A generic card cannot carry terminal output; a terminal card cannot carry a diff. The old bag permitted all of these.
- **Consumers switch instead of stitching.** One arm per card kind produces exactly the view that card needs, rather than reconciling five optional fields whose interactions are undocumented.
- **`diff` is a first-class intent.** `dsh-tool-fs` write/edit declare `card:'diff'` with `{path, oldText, newText}`, allowing capable UIs to render an inline change without tool-name special cases.

### Producer mapping

- `dsh-tool-fs` read → `generic` (`kind:'read'`, a follow-along `location`); write → `diff` (`oldText:null`); edit → `diff` (`oldText:old_string || null`, `newText:new_string ?? ''`). This mirrors `claude-agent-acp`'s `toolInfoFromToolUse` Read/Write/Edit arms field-for-field.
- `dsh-tool-bash` foreground → `terminal` call + `terminal` result; `run_in_background` → `generic`. The generic `job_*` controls own their own generic cards.
- `dsh-tool-todo` → `generic`.

### Terminal fallback ownership

`TerminalResultView` carries only `output`/`exitCode`/`signal`. A UI without the terminal capability needs a fenced ` ```console ` text fallback; that derivation moves to the **bridge** (it wraps `output` in a fenced block on the no-capability path), rather than the tool double-encoding it. This keeps the bash tool's result a single structured shape and preserves the existing capability-gated behavior byte-for-byte.

The terminal intent is display-only. The harness still executes the command through its bash service, preserving sandboxing, environment scrubbing, job ownership, and per-session cwd; a UI projects the completed call and never becomes a second execution backend.

### Purity preserved

`presentCall`/`presentResult` remain pure functions of `args` (+ the result for `presentResult`) — they run on live streaming AND session-log replay, so they must be replay-deterministic. Every view is derived from args alone: write's diff is new-file style (`oldText:null`) because the tool has no old content at call time; edit's diff is `old_string`→`new_string`.

## Alternatives considered

- **Delete tool-owned presentation entirely** — the rejected collapse proposal this note supersedes; its own verdict deferred to exactly this union once two real tools and two real consumers existed, and that bar is now met.
- **Let a UI execute terminal intents** — rejected because it would bypass the harness's bash policy and ownership contracts and fork command execution across backends. A terminal card describes harness-owned execution; it never authorizes client-side execution.
- **A merge-extensible union** (the `ContentBlockMap` pattern) — rejected: a new render intent needs new bridge code to render it anyway, so a plugin-added variant the bridge silently drops would be worse than the compile error the closed union raises at the bridge's `assertNever` switch.
- **Keeping the optional-field bag** — the status quo the Problem dissects: invalid states representable, undocumented field interactions, and no way to ask for a diff card at all.

## Consequences

A new render intent is a compile-breaking change at the bridge switch — deliberately: rendering code must exist before a card kind does. Invalid card/field combinations are now unrepresentable, and the bash fallback derivation lives in the bridge, so a tool returns one structured shape. The bar for a fourth card (a table, a chart) is writing its bridge arm in the same change.

## Non-goals

- **Live incremental `terminal_output_delta` streaming** and **command classification** — the terminal-rendering Agent Note's own deferred follow-ups, untouched here.

## Related

- Supersedes the deferral in the earlier rejected collapse-tool-owned-presentation proposal (rejected — "wait for two real tools and two real consumers, then a tagged render-intent union"). That bar is now met; this is that union.
- Extended by [Result-time applied-hunk diffs](../../archived/architecture/2026-07-02-result-time-applied-hunk-diffs.md) (archived), which added a persisted `meta` channel — the value/presentation split and the persisted `presentationMeta` channel are now owned by [the canonical tool output contract](../../../../packages/core/tools/README.md) so write/edit emit a result-time `DiffResultView` — the applied change (a contextual hunk with context lines / one per `replace_all` site, or a whole-file diff for a create) — on top of this union's call-time diff card.
- Folds `ToolTerminal` into the tagged `terminal` views used by current UI transports.
