# Agent Note: User-explicit skill invocation at the pre-step gesture boundary

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-08-user-explicit-skill-invocation.zh.md)

## Problem

A `disable-model-invocation: true` skill is user-only by design: it never enters the model-facing catalog and the `skill` tool refuses to load it. Its only legitimate entry point is an explicit user gesture — yet the web client had none. `skills/list` filtered to the model-and-user intersection (hiding user-only skills from the menu), an entered `/name` line rode into the default prompt sink as plain text, and the model it reached was forbidden to load the skill — so it degraded to `read`-ing the SKILL.md file or ignoring the gesture (issue #1470). Even for ordinary skills, the plain-text reference made user invocation a collaboration cue the model could ignore, not a guarantee.

## Decision

User-explicit invocation is a host-side pre-step injection, uniform for every user-invocable skill and every entry point:

- `dsh-tool-skill` registers a second `agent/pre-step` listener (beside its catalog listener, the same seam `agent-instructions` and the runtime-context snapshot ride): it scans the step's claimed messages for whitespace-bounded `/name` tokens — anywhere in the text, the same word-boundary shape the transcript chip decoration uses — collects first-seen-deduplicated names, loads each through `ctx.skills.get`, checks `isUserInvocable` on the loaded definition (the single lookup that produces what is injected), renders it with the shared `renderSkillContent`, and appends the injections after every other injection of the step: background first (workspace rules, runtime policy, catalog), the material the model must act on last, closest to its answer. Registration order pins the placement — the gesture listener registers before the catalog listener, so the waterfall hands it the catalog-bearing list to extend.
- Precision is closed-set matching, exactly like slash commands: `/goal` resolves against the command registry, `/name` against the workspace's user-invocable skill directory; a miss stays ordinary prose, so nothing is ever guessed. Only `source.kind === 'user'` messages are scanned — external text cannot forge a gesture. Paths (`/usr/bin`), fractions (`5/8`), and prefixed tokens (`foo/name`) all break the boundary.
- The client keeps the [plain-text-reference decision](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md): a menu pick lands the literal `/name ` and the prompt ships it verbatim; ui-skill implements no adjudication hooks and no reference codec. `skills/list` (now the domain's only RPC) serves every user-invocable skill with `modelInvocable` so menus mark user-only entries. A name shared with a host command resolves to the command — adjudication claims the line client-side before it becomes a prompt.
- The injection is a `user`-role message carrying the `skill-invocation` source (`{ name, form: 'instructions' }`), so `user/message` logging, the context-injection transcript row (labelled with the skill name), and replay all come free; `renderSkillContent` lives in the `dsh-skill` seam, shared verbatim with the `skill` tool result, and the catalog's closing sentence tells the model to follow an injected block instead of re-loading it.

Peer-product survey (Pi, OpenCode, Claude Code, Kimi Code, Codex, DeepSeek-Reasonix — local checkouts) was unanimous that user-explicit triggering is programmatic injection with zero model participation; the final shape is closest to Codex's core-side `$name` mention scanning, which likewise frees every entry point from implementing recognition.

## Alternatives considered

- **`skill.invoke` RPC (host injects, client claims)** — implemented first, in two iterations: a single mixed message (user text folded into the body), then a gesture prompt plus injection delivered through inbox primitives. Rejected after real-session testing: the mixed message polluted the injection with user prose; the two-message form depended on wake-ordering subtleties (`followup` claims the whole next-turn queue synchronously inside the first waking call, stranding any later message in the next turn — reproduced live), and the dedicated RPC duplicated a path `session.prompt` already provides while leaving TUI/ACP to reimplement recognition. The pre-step extension point removes the RPC, the claim machinery, and the ordering hazard outright.
- **`agent.inject()` from the RPC handler** — the inject queue (`next-step`, wake-free) is claimed ahead of the next-turn prompt, putting the injection above the gesture in the log; and pairing it with a waking `followup` reintroduces the same ordering coupling. The pre-step listener injects inside the step assembly, where ordering is explicit.
- **A host `/skill <name>` command** (command registry, plan-mode precedent) — two-token UX, no name completion, and user-only skills stay undiscoverable in the menu; the per-cwd skill catalog also fits the static command registry poorly. Rejected.
- **Client-side expansion** (fetch body, splice into the prompt) — authorization becomes bypassable client courtesy, the log loses the invocation semantics, and Codex deleted its equivalent mechanism (custom prompts) in favor of core injection. Rejected.
- **Structured reference payload on the prompt wire** (Codex's `UserInput::Skill` analogue: the client ships `{skills: [...]}` beside the text and the boundary prefers it over scanning) — considered and deferred: the existing slash-command system is itself line-text on the wire, and closed-set directory matching already removes the guesswork; recorded as a ledger item should gesture precision ever need client intent.
- **Per-injection preamble line** (Kimi's `User activated the skill …`) — dropped in favor of the one-time catalog sentence: same context, paid once, and the injected block stays byte-identical with the tool result.

## Consequences

- The plain-text reference is now the whole client story: the draft carries plain text, chip visuals derive from the lexicon, and the sent text is judged by the host boundary — a hand-typed gesture, a menu pick, and a TUI prompt are indistinguishable and equally deterministic.
- Every user-invocable skill invocation costs its full rendered body unconditionally — the price of determinism the peer survey showed everyone pays. Mentioning a known skill name mid-sentence loads it; that is the Codex mention semantic, accepted deliberately.
- The `skill-invocation` source rides `user/message`, so Model-visible ⟺ logged holds with no new event type, and replay/UI read metadata rather than text markers.
- Accepted residual of dropping the per-injection preamble: the no-reload framing rides only the catalog, and a workspace whose skills are all user-only never publishes a first catalog — an injection can arrive with no framing at all, and the model may redundantly try the `skill` tool once (the replacement catalog's empty arm carries the sentence; the never-published case does not). Publishing a catalog for framing alone was judged worse than that one recoverable error.
