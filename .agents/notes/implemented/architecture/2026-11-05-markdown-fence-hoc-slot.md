# Agent Note: Dispatch Markdown fences by language through a keyed hoc slot

Status: implemented

English | [中文](2026-11-05-markdown-fence-hoc-slot.zh.md)

## Problem

The conversation flow must render Markdown code fences by language and let plugins register, replace, or decorate the rendering of one language. With fence branches fixed inside primitives — `renderCode` in [render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx) sends `math` to KaTeX, [CodeBlock.tsx](../../../../packages/client/ui-primitives/src/markdown/CodeBlock.tsx) colors `diff` / `patch` rows, and everything else goes to shiki — a new language such as mermaid means another branch in those two files, and a plugin can neither register a renderer for a language nor replace or decorate an existing rendering at one location.

[ui-primitives](../../../../packages/client/ui-primitives/README.md) has no Cordis dependency, so its components cannot reach slots. `MarkdownText` has more than ten callers, most of which need no extension, and their rendering must stay exactly as it is.

## Decision

### Dispatch entry

- `MarkdownDelegate` has an optional `renderCode(fence: MarkdownDelegateFenceInfo): ReactNode`. `MarkdownDelegateFenceInfo` has four fields: `lang` (the leading letters, digits, `_`, and `-` of the info string's language word, lowercased, so `c++` yields `c`), `code` (the fence body), `streaming` (whether the surrounding document is still streaming), and the optional `meta` (the info string after the language word, as written; it shares the first line with `lang` and is final once content appears).
- `renderCode` runs only once `lang` is final: the fence has a language and non-empty content. While streaming, the info-string line has ended by the time content appears, so `lang` cannot change and dispatch never reverts; a fence whose info string is still incomplete has no content and takes the empty-fence branch.
- Where no `renderCode` is supplied, primitives use the built-in default: diff rows follow `lang`, and `math` renders as KaTeX after the document settles.
- Where `renderCode` is supplied, the owner handles every language: it declares its own slot and registers the layers it needs. Primitives do not fall back to diff or math for it.
- Primitives wrap the output of `renderCode` in a block box, `fenceSeat`, which takes the fence's vertical spacing among adjacent blocks; code blocks and display formulas inside it carry no margins, and layer root elements set none either. Without `renderCode`, no box is added.

### Primitives presets

| Item | Content |
|---|---|
| `CodeBlock` `diff` switch | Omitted follows `lang`; `true` / `false` forces diff rows on or off for any `lang` |
| `FenceCodeBlock` | Fence preset: hands the fence to `CodeBlock`, appends the trailing newline the Markdown renderer expects, and forwards `diff` |
| `FenceMathBlock` | Fence preset: display KaTeX, with the trailing newline appended |
| Built-in default | `MarkdownFenceSeat` in `render.tsx` reads the delegate inside a Component, so cached streaming elements follow a Provider change; without `renderCode` it renders the two presets above |

### Hoc dispatch (ui-slots / ui-renderer)

| Item | Content |
|---|---|
| Registration | A hoc registration has an optional `key`; omitted, the layer is a wildcard that matches every `entryKey` |
| Cell | `(key or wildcard, id)`; the same cell at the same `priority` throws, a different `priority` shadows |
| Dispatch | `renderSlot(name, owner, { entryKey, children })`; applies only wildcard layers and layers whose `key === entryKey`; an omitted `entryKey` applies only wildcard layers |
| Exact key first | Within one `id`, an exact-key layer replaces the wildcard layer |
| Nesting order | `order`, then `priority`, then registration order; lowest `order` outermost |
| children | A layer renders `children` at most once and may omit it to replace everything inside; applies to every hoc |
| Crash | A crashed layer reports its error without abdicating (`abdicate: false`): only the occurrence that failed renders `children` (the inner content), the layer stays registered, and other occurrences of the same key are unaffected; the failed occurrence does not retry within its mount, even when props change, and recovers when it remounts; applies to every hoc |
| Compilation | Compiled once per `(host, slot declaration, entryKey)` and shared by every outlet; each ledger version reselects the key's ordered layers and compares them entry by entry, reusing the chain when unchanged and recompiling only on change; a registration for another key does not remount mounted content, an outlet that switches `entryKey` switches chains and remounts its content, and a redeclared slot starts with an empty cache |

The layers of `conversation.hero.frame` have no key and are all wildcards, and ui-conversation passes no `entryKey`; those layers may also omit the hero content.

This note partially supersedes four decisions of [hoc slot kind](2026-11-03-hoc-slot-kind.md): the obligation to render `children` exactly once, hoc rejecting `entryKey`, per-outlet `useMemo` layer composition, and abdication of a crashed layer. That note's other decisions remain in force, and the hoc facts it records agree with this note.

### Chat flow (ui-chat)

- ChatView declares `'conversation.chat.markdown.fence': { kind: 'hoc', scope: 'session' }` in its `conversation.view` id=chat registration, with `MarkdownDelegateFenceInfo` as owner props, and supplies `renderCode` on its existing `MarkdownDelegateProvider`: `renderSlot('conversation.chat.markdown.fence', fence, { entryKey: fence.lang, children: <FenceCodeBlock diff={false} …/> })`.
- Coverage equals that Provider's scope: every `MarkdownText` inside `conversation.chat.flow`, including replies, reasoning, compaction summaries, and tool details. Within that scope, the `labels` of `conversation.chat.reasoning.content` apply only to footnotes and fences without a language.
- `src/client/fence/` registers two kinds of layers, with literal package-path ids so the slot catalog can list each layer id:
  - `key: 'math'`: renders `children` while streaming and only `FenceMathBlock` after the document settles.
  - `key: 'diff'` and `key: 'patch'` (one id): render `FenceCodeBlock diff` and omit `children`.
- Third parties register layers by language; to replace a language's default rendering in the flow, register a layer for that key that omits `children`; to decorate it, render `children`. A layer may read `meta` to parse info-string parameters itself.
- Layer contract: the root element sets no margins (`fenceSeat` owns spacing); a layer that cannot handle incomplete content renders `children` while `streaming`, because a mid-stream crash otherwise leaves that occurrence on the code block for the rest of its mount; a layer catches its own content-dependent errors.

### Styling

The outlet's `[data-slot]` (`display:contents`) wrapper sits inside the box, so the box is the direct child of `.markdown` and `li`; first- and last-child margin resets, the list-item first-child reset, and the 11px `:not(:last-child)` rule all apply to the box directly:

| Rule | Box value |
|---|---|
| Default | `margin: 16px 0` |
| Followed by a sibling | `margin-bottom: 11px` (matching `CodeBlock`'s `.block:not(:last-child)`) |
| compact variant | `margin: 4px 0` |
| Last child of a list item | Keeps its margins like a code block (`li > *:last-child:not(.md-code-block, .fenceSeat)`) |
| `.md-code-block` and `.katex-display` inside the box | `margin-block: 0` |

The slot anchor keeps the general hoc behavior.

## Alternatives considered

- **Keep `diff` / `math` on fixed primitives branches and open a slot only for new languages**: two mechanisms for old and new languages, and built-in renderings cannot be replaced or decorated.
- **A global Provider installed by AppFrame covering every CodeBlock**: adds application-wide global state and conflicts with the rule that a document without `renderCode` keeps the built-in rendering.
- **A shared Factory carrying the base diff / math registrations, with each slot wrapping the Factory**: workable but structurally heavier; "an owner that defines `renderCode` handles every language" is simpler.
- **Two hoc levels (a fence layer plus a CodeBlock body layer)**: diff needs only an existing `CodeBlock` switch, not a second level.
- **An "anchorless" hoc declaration to avoid the wrapper element**: changes a general slot property; the styling problem is solved in the styles.
- **No box, with "one level removed" structural rules restoring edge and list spacing**: the rules assume exactly one wrapper and a single root element, break when a layer emits several roots or one more wrapper, and cannot restore the 11px gap.
- **Abdicate the whole crashed layer (the other kinds' semantics)**: one content-triggered crash would send that language back to code blocks in every Session until re-registration.
- **Retry after a crash when owner props change**: requires state and shallow comparison in the error boundary every kind shares, and a faulty layer would report once per streamed chunk. No retry only needs hoc layers to report with `abdicate: false`.
- **An html preview layer**: kept as a mechanism demonstration and security investigation only, outside this scope; browsers cannot block script-initiated self-navigation of an iframe, which needs its own design.
- **Register the default rendering as a wildcard layer**: other plugins would need its `order`, and a layer with a larger `order` would nest inside a default layer that omits `children` and never mount; passing it as hoc content requires no id or `order` knowledge.
- **`MarkdownDelegateFenceInfo` carrying `labels` and the language name in its original case**: each layer chooses its own chrome copy; a lowercase `lang` in the banner is acceptable.
- **Per-outlet `useMemo` layer composition**: many same-language fences in a Session each compose the same chain, and any registration change remounts every fence; sharing compiled chains per `(slot declaration, entryKey)` applies only to hoc, unlike the "precompile every kind per ledger version" option that [hoc slot kind](2026-11-03-hoc-slot-kind.md) rejected.

## Consequences

- Plugins add, replace, or decorate fence rendering in the flow by language without touching primitives; `math`, `diff` / `patch`, and third-party languages share one mechanism.
- `MarkdownText` callers without `renderCode` render the built-in blocks, with no box and no slot.
- A content-triggered layer crash affects only the occurrence that failed; other fences of the same language keep the layer.
- Same-language fences share one compiled layer chain; registering a layer for another language does not remount mounted fences.
- Layers of every hoc may omit `children`: a `conversation.hero.frame` layer can hide the hero content.
- Hoc layer crashes do not abdicate: a faulty layer crashes and reports again at every mount, and that occurrence keeps showing its inner content.
- In the flow, display formula spacing comes from the box (16px / 11px), not KaTeX's default 1em.
- On the delegate path, each fence with a language adds one block box element.
- In the flow, each fence with a language adds one slot outlet (one registry subscription, one locale subscription, and one `display:contents` element); compiled chains are shared per key.
- In the flow, custom labels that ReasoningContent callers pass do not apply to fence chrome; fence chrome copy comes from ChatView's locale.
- In the flow, fence banners show the lowercase `lang`.
