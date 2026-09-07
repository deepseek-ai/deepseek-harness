# Agent Note: System prompt expands into the opaque context body

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-17-web-system-prompt-opaque-body.zh.md)

## Problem

The Chat `System prompt` row shares `DisclosureRow` chrome with context injection and needs an expanded body for the request's system field. Rendering that field as Markdown would restyle it — headings, emphasis, lists — so a reader would see a rendered document the model never received. Context injection already solves the same job with a 141px code-block scrollport and `<pre>` text that keeps the bytes and line breaks the model read, so the row needs that presentation, not a second one.

## Decision

`SystemPromptRow` mounts the same expanded body as an opaque context injection. It reuses `ContextInjectionRow.module.css` for the 141px Figma 10:2482 scrollport and renders the durable `request/header` system string through `OpaqueBody` as one text block, so the disclosure shows model-facing text with its real line breaks and the same 20_000-character display bound. The row stays collapsed by default and still has no streaming path. It does not grow a producer label, form marker, or source-field list: the system field is one joined string on the header, not a sourced `user/message`.

## Alternatives considered

**Render settled Markdown in a card-styled body.** The chrome could match, but Markdown rewrites what the model read. A heading or bold span is a different document from the request bytes.

**Split the joined system string into snapshot sections.** The durable header stores only the assembled text. Inventing section boundaries in the client would attribute prose the log does not name, and a resumed or foreign header could not reconstruct them.

**Render through `ContextInjectionRow` itself.** That row is for sourced user-role messages: it titles a role, shows a producer, and chooses a form body. The system field is a different durable fact and has none of those fields.

## Consequences

The two disclosures now share one expanded-body chrome and one text presentation, so a later change to the 141px scrollport or the opaque bound applies to both. The cost is that a long system prompt scrolls inside 141px instead of 360px, and Markdown markup in the prompt stays visible as characters.

## Testing

`packages/client/ui-chat/tests/system-prompt-row.client.spec.tsx` expands and collapses the row and pins the opaque `[data-context-text]` bytes, including Markdown markers that must not become a heading. `apps/web/tests/replay-round-trip.e2e.ts` still opens the assembled disclosure and reads the persona line from that body.
