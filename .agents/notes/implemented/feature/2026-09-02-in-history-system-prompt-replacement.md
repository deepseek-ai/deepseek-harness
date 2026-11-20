# Agent Note: In-history system-prompt updates

Status: implemented

English | [中文](2026-09-02-in-history-system-prompt-replacement.zh.md)

## Problem

Rewriting the leading prompt when plan guidance, tools, persona or model variables change invalidates the provider prefix from its first token. Later instruction messages can preserve the preceding conversation prefix, but their representation depends on model capabilities. The [surface-node decision](../architecture/2026-09-02-system-prompt-as-surface-node.md) makes their original positions durable.

## Decision

The cache-preserving choice remains: log instructions when they enter the conversation instead of routinely moving them to its beginning. [Section-based updates](../architecture/2026-10-21-section-based-system-updates.md) supersede the original route-gated whole-prompt rule. They append changed source text and explicit notices on every route; the loop does not select the latest system message as the entire prompt or consolidate because native updates are unavailable. [Compaction](../architecture/2026-11-09-deferred-system-compaction.md) provides the explicit consolidation point, while [unchanged series starts](../bug-fix/2026-10-22-series-start-unchanged-prompt-prefix.md) preserve retained instruction positions.

`systemPromptUpdate = 'in-history'` remains a declared model capability on resolved model information and prepared calls, recorded in request context. Catalogs validate the value; model names or protocol families do not imply support. The declaration describes native representation, not permission to admit section deltas. Adapters preserve all instructions using native messages, a combined system field or the [pi-ai reminder fallback](../architecture/2026-10-19-pi-ai-system-reminder-fallback.md). The bound prepared call, rather than a preceding request-context snapshot, determines serialization.

Instruction and user commitment follows successful request middleware and preparation inside an open step. Cancelling either preparation phase leaves them uncommitted. New instructions precede newly admitted users. Retries do not rerun assembly, pre-step selection or user admission; after compaction, the next attempt rebuilds the instructions from the same captured sections. Resume retains committed instructions and appends changes, because a process restart alone need not invalidate provider caches.

### Presentation and accounting

Chat shows a later nonempty system node as a collapsed update card and avoids repeating it in a same-step request header. Trajectory can represent it as a synthetic request-header fact. Header configuration and tools remain independent of instruction changes; comparing only real headers would miss an intermediate system update. If the loaded window contains no earlier system node, the node appears as an initial prompt. Human transcripts omit system messages.

Request-prompt inspection uses immutable prefix states ordered by surviving conversation positions, not simply event sequence or source citations. Head rewrites can be logged after later-position updates; replacements can remove system nodes. Empty nodes remain addressable without erasing other retained text. When a replacement endpoint predates the known window and its position is unknown, inspection withholds later prompt text until prepend replay resolves the missing prefix. Numeric event order cannot safely guess the position. Historical cards retain their own prefix state.

Token breakdown counts every surviving system message as system tokens. The [compact accounting state](../architecture/2026-10-13-context-breakdown-system-prompt-state.md) keeps system nodes and a running total rather than per-message accounting entries. Provider `cacheReadTokens` remains the observable cache signal; neither additive admission nor native-support metadata guarantees a cache hit.

## Alternatives considered

**Route-gated whole-prompt replacement.** The original design treated the latest system message as the complete prompt and rejected section deltas under that assumption. Canonical per-source records and explicit replacement or retirement notices make additions meaningful without that interpretation; adapter fallback preserves them on other routes. Its former series-start and incapable-route consolidation rules are therefore not current behavior.

**A deployment switch instead of declared native capability.** A flag could misrepresent what the selected model accepts. Capability remains model-owned even though it no longer gates section admission.

**Always append, or consolidate on every series start or resume.** Unlimited appends retain stale head text and consume context; compaction supplies consolidation. A local replacement can leave most of the prefix valid, and restart can retain a warm provider cache, so neither alone justifies moving instructions. Model swaps likewise need no special consolidation rule beyond the recorded route change.

**Commit before pre-step and request preparation, or put updates after new users.** Early commitment can admit cancelled content or miss a compaction that removes the instructions an update was compared against. Putting updates after users reverses the established instruction-before-input order. Capture can happen earlier, but comparison and commitment must follow any compaction and precede request derivation.

**Use prior request context to decide the current representation.** It describes a previous call and can be wrong for the first call, resumed sessions or route changes. The actual bound adapter owns current serialization.

**Clear only the latest system node during consolidation.** Older instructions would survive and could become effective again. Rebuilding clears retained additions before replacing the initial head, preserving intervening conversation.

**Keep only scalar accounting totals.** Replacement prices cannot identify which system nodes disappeared. Retaining only those nodes with shadow-price metadata supports classification without a per-message checkpoint.

## Consequences

Appending an update can preserve the provider prefix, but every retained update consumes input tokens until consolidation or removal. Frequently changing facts remain better suited to runtime context. Adapters that flatten instructions can invalidate the leading prompt, and user-role reminders do not acquire system authority. Proxies that rewrite or reorder messages can also defeat the intended instruction order or cache reuse.

## Verification

Loop and request-reconstruction tests cover route changes, resume, cancellation, fixed retry assemblies, rebuilding after compaction and unchanged prefixes. Client tests cover update cards, header deduplication, historical prefix inspection and incomplete-history withholding. Accounting tests cover retained system nodes, replacements and replay. TypeScript and Python SDK expected outputs include appended typed system events, while keyless recorded sessions pin instructions in conversation order. Real-API adapter coverage uses `DEEPSEEK_IN_HISTORY_MODEL` to check following an appended update and compare provider cache reuse with a rewritten leading prompt; it skips without that setting. These live-provider checks remain necessary because metadata cannot establish model behavior.
