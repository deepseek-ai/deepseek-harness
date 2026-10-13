---
description: "Web display masking for recognized credentials in sent user text, with a per-value reveal control in interactive messages."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-secret-mask

English | [中文](README.zh.md)

## Summary

Use `dsh-client-ui-secret-mask` when Web users paste API keys, tokens, or passwords into messages that others may see on a shared screen or in a screenshot. Sent user text draws each recognized credential masked: a key or token keeps its first eight characters, and each remaining character is drawn as `*`. Masking changes only what is drawn; the message text, the copy action, and the model input keep the original characters.

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

Mount the package beside `dsh-client-ui-conversation`. The Web app bundle mounts it by default; removing its row draws credentials as written. Every caller of the [UserText Factory](../ui-conversation/README.md#sent-user-text) masks: message bubbles, steering messages, pending echoes, queued messages, and `/goal` input bubbles.

Each masked value is drawn in a monospace font, so revealing it does not move the surrounding text. Interactive text, which is a sent message or an admitted steering message, adds an eye control at the end of each run. The control reveals or hides that one value, and every mount starts masked. Other callers draw the masked value without a control.

<a id="what-is-masked"></a>
### What is masked

| Value | Examples | Display |
| --- | --- | --- |
| Model-service and Google API keys | `sk-…` with at least one digit, `AIza…` | First eight characters kept |
| Code-hosting and package-registry tokens | `ghp_…`, `github_pat_…`, `glpat-…`, `npm_…`, `hf_…` | First eight characters kept |
| Cloud access key IDs | `AKIA…`, `ASIA…`, `LTAI…`, `AKID…` | First eight characters kept |
| Collaboration and payment tokens | `xoxb-…`, `sk_live_…`, `rk_test_…`, `whsec_…` | First eight characters kept |
| JSON Web Tokens | `eyJ….eyJ….…` | First eight characters kept |
| Private key blocks | `-----BEGIN … PRIVATE KEY-----` through its `END` line | `BEGIN` and `END` lines and line breaks kept |
| Address passwords | `postgres://user:password@host/db` | Password masked completely, including a token used as one |

Named assignments such as `password=…` or `API_KEY=…`, passwords written in a sentence, verification codes, and personal data have no published format and stay as written.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one UserText matcher, `secret`, and its keyed `conversation.user.text.node` renderer; the `/client` export is the plugin body (`apply`/`inject`) only. The matcher reads no Facts, so Facts updates never query it again. Each query returns the nearest credential at or after the requested offset and allocates nothing before it returns a node. A literal-only alternation finds where a format can begin; where a literal's suffix can begin another literal, the scan resumes at that suffix. Format checks are bounded character comparisons and sticky `[class]*` patterns, which stop at the first character outside the class and leave nothing to backtrack into. The matcher instance that `apply` creates memoizes run ends, the next digit, and the next private-key `END` line per text across queries, so all queries of one text cost linear time together; the instance keeps the last queried text until a query for another text. At an equal start, the private-key, address-password, and prefix formats win in that order, and every overlapping candidate joins the earliest under its mask. When an address's `://` precedes the requested offset, the matcher walks back over the user name only if `:`, a password, and `@` follow the offset, so a query from anywhere inside an address finds the same password. The [user-text benchmark](../../../benchmarks/user-text/user-text.bench.client.ts) bounds evaluation time for text with and without credentials, linear scaling, and the matcher's allocation ([rationale](../../../.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.md)).

The node payload carries only the masked display text. The renderer draws each run of `*` as centered marks while keeping the characters for copying and assistive technology, because a font's own asterisk sits near the cap height. It switches between that text and the node's original text, and it remembers the revealed original value instead of a flag, so a different credential at the same position starts masked.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-conversation sent user text](../ui-conversation/README.md#sent-user-text) — the matcher registry, the scheduler, and the node renderer Slot.
- [User text candidate scheduling](../../../.agents/notes/implemented/architecture/2026-10-10-user-text-json-nodes.md) — the forward-query and cache rules this matcher follows.
- [Credential matching performance](../../../.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.md) — the linear matcher, its per-part complexity and trade-offs, and the time and allocation gates.

-----

<a id="model-experience"></a>
## Model Experience

None, as masking changes only what the browser draws; the message text and the model input keep the original characters.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when a credential is drawn as written; they are current package constraints.

- **Recognition requires a published format** — a credential without one of the [recognized formats](#what-is-masked) is drawn as written. Named assignments stay plain because the same names also label ordinary values, such as token usage.
- **Only UserText callers mask** — session titles, turn previews, search excerpts, the goal bar, tool cards, assistant replies, and the unsent composer draw credentials as written.
- **An earlier reference draws its own text** — a credential inside a reference that starts before it, such as the file mention `@config/<key>.txt`, is drawn by that reference.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
