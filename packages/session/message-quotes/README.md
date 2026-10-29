---
description: "Quotation controls and Markdown blockquote presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-message-quotes

English | [中文](README.zh.md)

## Summary

`dsh-message-quotes` registers quotation controls and transcript rendering on the Client. Messages retain ordinary Markdown text without quote metadata or content indexes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle mounts this plugin. Its Client entry registers the selection action with `ctx.uiConversation.interactions` and renders quotes through UserText rules. Registrations are removed when the plugin unloads. The selection button uses the shared floating-surface stroke and shadow.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The shared [Markdown formatter](../../client/ui-primitives/README.md#rendering-agent-output) encodes quoted text for the composer. The plugin owns [quote recognition and decoding](src/client/quote-text.ts). Quote previews render their contents as plain text, including recognized Session labels, with uniform typography and no reference-chip decoration. Selection eligibility, local positioning, and dismissal belong to the conversation interaction service; the quote action extracts its text from the DOM. The composer owns QuoteNode editing and serialization.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session package map](../README.md) — related persistence and projection packages.
- [Conversation subsystem](../../../docs/subsystems/conversation.md) — composer and transcript consumers.

-----

<a id="model-experience"></a>
## Model Experience

### Quoted message text

#### What the model sees

The composer sends selected text as ordinary Markdown blockquotes, with one `> ` prefix per line. Session-reference and skill processing applies normally to quoted text.

#### Token effect

Quote text and its line prefixes contribute ordinary input tokens.

#### KV Cache effect

The plugin rewrites no history. Consumers append the encoded text as user content after the existing prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Recognition covers explicitly marked lines with up to three leading spaces; it does not implement Markdown lazy continuation or fenced-code parsing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
