# Agent Note: Dispatch Markdown fences by language through a keyed hoc slot

Status: implemented

English | [中文](2026-11-05-markdown-fence-hoc-slot.zh.md)

## Problem

A Markdown fence is a fenced code block: an opening line of three or more backticks or tildes followed by an info string, such as `ts title=demo`, then the body and a closing fence. The info string's first word names the fence's language.

The Chat flow renders fences by language, and plugins need to register, replace, or decorate the rendering of one language. Primitives choose fence rendering in fixed branches — `renderCode` in [render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx) sends `math` to KaTeX, [CodeBlock.tsx](../../../../packages/client/ui-primitives/src/markdown/CodeBlock.tsx) colors `diff` / `patch` rows, and other languages go to shiki. [ui-primitives](../../../../packages/client/ui-primitives/README.md) has no Cordis dependency, so its components cannot reach slots, and the other `MarkdownText` callers must keep their rendering unchanged.

## Decision

### Developer-facing API

The API has two parts: a delegate that hands each fence to its owner, and a keyed hoc slot through which plugins register language renderers.

| Part | Contract |
|---|---|
| Delegate | `MarkdownDelegate.renderCode?(fence: MarkdownDelegateFenceInfo): ReactNode`. An owner that supplies it on `MarkdownDelegateProvider` renders every fence in that scope that has a language and content |
| Fence info | `lang` (the leading letters, digits, `_`, and `-` of the info string's language word, lowercased, so `c++` yields `c`), `code` (the body), `streaming` (whether the document is still streaming), and optional `meta` (the info string after the language word, as written) |
| Keyed hoc slot | The owner dispatches each fence to its hoc slot with `entryKey: fence.lang` and passes the plain code block as `children`; plugins register layers by language `key` |
| Chat flow | ChatView supplies the delegate and declares `conversation.chat.markdown.fence` (hoc, session scope) with `MarkdownDelegateFenceInfo` as owner props; its scope is every `MarkdownText` inside `conversation.chat.flow` |

A plugin registers a layer for one language:

```text
ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register(
  { name: 'conversation.chat.markdown.fence', key: 'mermaid', id: '@acme/plugin/mermaid' },
  ({ code, streaming, children }) => (streaming ? children : <MermaidDiagram source={code} />),
))
```

The API guarantees:

- `lang` and `meta` are final when `renderCode` first runs: the info-string line ends before content appears, and a fence without content takes the empty-fence branch.
- The plain code block is the innermost `children` of every dispatch. A language without a layer, a layer that renders `children`, and a crashed layer all show it.
- Each streamed chunk reaches the same layer instance as new owner props; the layer owns streaming. A layer that cannot render incomplete content renders `children` while `streaming`.
- A layer that omits `children` replaces the code block; a layer that renders `children` decorates it. A layer may parse `meta` itself and keeps its root free of outer margins.
- A document without `renderCode` keeps the built-in rendering: diff rows follow `lang`, and `math` renders as KaTeX once settled.
- Chat registers `math` (source while streaming, display TeX once settled) and `diff` / `patch` (unified-diff rows, `children` omitted) under literal package-path ids.

### Hoc slots with dispatch keys

| Item | Contract |
|---|---|
| Registration | Optional `key`; a layer without `key` is a wildcard that serves every dispatch |
| Cell | `(key or wildcard, id)`; the same cell at the same `priority` throws, and a lower `priority` shadows |
| Dispatch | `renderSlot(name, owner, { entryKey, children })` applies wildcard layers and layers whose `key === entryKey`; without `entryKey`, only wildcard layers apply |
| Exact key first | Within one `id`, an exact-key layer replaces the wildcard layer |
| Nesting | Ascending `order`, then `priority`, then registration order; lowest `order` outermost |
| children | Rendered at most once; omitting it replaces everything inside the layer |
| Crash | The failed occurrence renders `children` for the rest of its mount and the error is reported; the layer stays registered (`abdicate: false`) and other occurrences keep it; the occurrence retries when it remounts |
| Compilation | One chain per `(host, slot declaration, entryKey)`, shared by every outlet; each ledger version reselects that key's layers and recompiles only when they change, so a registration for another key leaves mounted content in place, while switching an outlet's `entryKey` switches chains |

These hoc semantics apply to every hoc slot, including `conversation.hero.frame`, whose layers are all wildcards. This note partially supersedes four decisions of [hoc slot kind](2026-11-03-hoc-slot-kind.md): rendering `children` exactly once, rejecting `entryKey`, per-outlet `useMemo` composition, and abdicating a crashed layer.

### Code blocks

| Item | Contract |
|---|---|
| `CodeBlock.diff` | Omitted follows `lang` (`diff` / `patch`); `true` or `false` forces unified-diff rows on or off for any `lang` |
| `FenceCodeBlock` | Renders a fence body through `CodeBlock`, appending the trailing newline that `CodeBlock` trims, and forwards `diff`; ChatView's dispatch content passes `diff={false}` |
| `FenceMathBlock` | Renders a `math` fence body as display KaTeX |
| `MarkdownFenceSeat` | The Component in `render.tsx` that reads the delegate, so cached streaming elements follow a Provider change; without `renderCode` it renders the two presets |

### Spacing

Primitives wrap each delegated fence in a block box, `fenceSeat`, the direct child of `.markdown` or `li`. The box takes a code block's spacing among its siblings, so the slot's `display: contents` anchor inside it does not affect the document rhythm:

| Rule | Box value |
|---|---|
| Default | `margin: 16px 0` |
| Followed by a sibling | `margin-bottom: 11px` |
| compact variant | `margin: 4px 0` |
| Last child of a list item | Keeps its margins, like a code block |
| `.md-code-block` and `.katex-display` inside the box | `margin-block: 0` |

## Alternatives considered

- **Keep `diff` and `math` on fixed primitives branches and open a slot only for new languages**: two mechanisms, and built-in renderings cannot be replaced or decorated.
- **Register the default code block as a wildcard layer**: other layers would need its `order`, and a layer ordered inside it would never mount because the default omits `children`; as hoc content it needs no id or `order`.
- **Restore spacing with selectors that skip one wrapper level instead of a box**: they assume exactly one wrapper and one root element, and cannot restore the 11px gap.
- **Abdicate a crashed layer, as single, keyed, and list do**: one content-triggered crash would remove that language's rendering from every fence until re-registration.
- **Retry a crashed occurrence when owner props change**: needs state and shallow comparison in the error boundary every kind shares, and a faulty layer would report once per streamed chunk.
- **Compose layers per outlet**: every same-language fence would compose the same chain, and any registration would remount every fence.

## Consequences

- Plugins add, replace, or decorate Chat flow fence rendering by language without changing primitives; `math`, `diff` / `patch`, and third-party languages share one mechanism.
- `MarkdownText` callers without `renderCode` render the built-in blocks, with no box and no slot.
- A layer crash affects only the fence that failed; a faulty layer crashes and reports again at each mount while that fence shows the code block.
- Layers of every hoc slot may omit `children`, so a `conversation.hero.frame` layer can hide the hero content.
- Each delegated fence adds one block box and one slot outlet (one registry subscription, one locale subscription, and one `display: contents` element); compiled chains are shared per key.
- In the Chat flow, display formula spacing comes from the box rather than KaTeX's default 1em, fence banners show the lowercase `lang`, and the `labels` of `conversation.chat.reasoning.content` apply only to footnotes and fences without a language.
