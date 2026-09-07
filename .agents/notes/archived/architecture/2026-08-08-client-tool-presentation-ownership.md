# Agent Note: Client Tool presentation ownership

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-08-client-tool-presentation-ownership.zh.md)

## Problem

Client Runtime already paired Tool call/result events by `callId` and could recover root/subcall topology from Code Dispatch events, but the Chat view also owned Tool placement in the conversation flow, recursive call-tree composition, Tool-name dispatch, the Generic fallback, card models, and first-party Tool renderers. `ui-conversation` therefore had to interpret every business Tool name; moving individual React components did not change that ownership, and removing atomic renderers left subcalls without a presentation owner.

Tool presentation needed an independent owner without adding a second registry beside Client slots or making every atomic Tool renderer understand root/subcall structure.

## Decision

Tool is a first-class Client UI presentation concept. `@deepseek-ai/dsh-client-ui-tool` owns root/subcall composition, atomic renderer dispatch by wire Tool name, the Generic fallback, card models, and details output. Business plugins register only their atomic Tool renderers and do not modify conversation or Session.

Conversation data assembly follows the later [Conversation business-node decision](2026-08-09-client-conversation-node-assembly.md). The `ui-conversation` Tool Definition pairs root call/result Session Events, folds Code Dispatch edges into recursive `ToolCallBlock.subCalls`, and emits one stable `tool-call` Chat Node. This data responsibility handles only official Tool identity and topology; it does not interpret presentation for concrete Tool names.

[`ChatView`](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) only places generic [`ChatNodeSeat`](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) entries in Chat snapshot `order`. A Seat dispatches `'conversation.chat.node'` by `node.kind`; [`ui-tool`](../../../../packages/client/ui-tool/src/client/apply.ts) registers the `tool-call` entry, and [`ToolCallTree`](../../../../packages/client/ui-tool/src/client/tool/ToolCallTree.tsx) recursively traverses the root block. Every root or child level dispatches through the same keyed/session `'tool.call.toolview'` child slot with `entryKey: toolName`, falling back to `GenericToolCard` when no registration exists.

A business Tool plugin receives one standard `ToolCallBlock`, identity, workspace cwd, and host actions; it does not read Session, Context, or the Conversation assembler. Skill remains an ordinary Tool and uses the same keyed-slot registration path as other business Tools.

The details panel is a second Tool presentation point, not the call-tree owner. `ui-conversation` locates the selected call and delegates its output body through `'conversation.details.tool'`; `ui-tool` reuses the card model, while the conversation fallback retains raw result text when the plugin is absent.

Generic row models retain the original argument string as `bodyRaw` and expose no preformatted body. `ToolRow` and the Bash fallback format it only while an expanded generic input section is visible; closing the row removes the formatted text, and rows rendering a structured card skip generic-body formatting.

## Runtime and render path

```text
Session Event window
  -> Tool Definition -> tool-call Chat Node (recursive ToolCallBlock)
  -> ChatView -> ChatNodeSeat(entryKey = tool-call)
  -> ToolCallTree
       -> root/subCalls[] recursion
       -> tool.call.toolview(entryKey = toolName)
            |- registered atomic view
            `- GenericToolCard fallback
                 |- collapsed or structured card: retain argsRaw only
                 `- expanded generic input: format argsRaw
```

## Ownership boundary

| Owner | Owns | Explicitly does not own |
|---|---|---|
| Client Runtime Conversation engine | Context identity, Location, history replay, view Node publication | Tool event meaning, call tree, Tool renderer |
| `ui-conversation` Tool Definition | call/result pairing, Code Dispatch topology, running/settled/interrupted `ToolCallBlock`, Chat ordering anchor | Tool-name dispatch, card models, recursive React structure |
| `ui-conversation` Chat view | keyed Node order, scroll anchors, selection, and host actions | Tool lifecycle, subcall composition, atomic Tool renderers |
| `ui-tool` | root/subcall recursive rendering, atomic keyed dispatch, fallback, card models, expansion-time argument formatting, and details output | Session Event fold, Chat ordering |
| Business Tool plugin | atomic renderers for one or more wire Tool names | root/subcall placement, lifecycle pairing, Session projectors |

## Verification

`ui-conversation` tests pin the Tool Definition's call/result pairing, Code Dispatch, interruption, and running-to-settled keyed identity without importing production `ui-tool` renderers. `ui-tool` tests mount the real conversation host and pin root/subcall recursion, keyed dispatch, Generic fallback, selection, details, concrete Tool cards, and expansion-only generic-body formatting. Assembled Web tests cover the path with both plugins loaded.

## Alternatives considered

**Keep atomic Tool slots under every conversation view.** Rejected: every view would repeat root/subcall composition and Tool registration would split by view. The whole Tool renderer occupies one business Node slot in a view, while Tool owns atomic dispatch.

**Move only Tool React components and card models.** Rejected: conversation would still dispatch by Tool name and recurse through subcalls, so file movement would not create an ownership boundary.

**Create a Tool-specific projector/fold registry.** Rejected: the general Conversation assembler already owns Context identity, history windows, and publication. A second Runtime registry would create two lifecycle authorities.

**Let every atomic Tool renderer recurse through its subcalls.** Rejected: an atomic registrant should understand one Tool call without knowing whether it is a root or child. `ToolCallTree` handles recursive structure once.

**Let `ui-conversation` import `ui-tool` components directly.** Rejected: this would reverse the feature dependency and make Tool presentation mandatory. Slots preserve independent loading, lifecycle, and fallback behavior.

**Keep a preformatted body on the row model for compatibility.** Rejected: every collapsed row would retain a second full argument string, and the compatibility field would let future consumers restore eager formatting. The model exposes only `bodyRaw`, making expansion-time formatting the only generic path.

## Consequences

`ui-conversation` no longer depends on presentation for concrete Tool names, and root and subcalls cannot drift onto different dispatch paths. Business packages can independently own atomic Tool renderers; if `ui-tool` is absent, Conversation data assembly remains valid, Chat Nodes use the generic fallback, and details retain raw results.

Collapsed Tool rows retain the existing `argsRaw` reference without a pretty-printed copy or its formatting call. Expanding a generic input performs that work for the visible row, and closing it permits the derived text to be collected; repeated expansion trades bounded recomputation for lower retained memory.

The cost is an explicit dependency from `ui-tool` on the business Node slot and locale namespace declared by conversation, plus one Tool-specific child slot. Tool Definition remains in `ui-conversation` because this change does not split packages; it can later move through the Conversation registry seam without changing the presentation ownership recorded here.
