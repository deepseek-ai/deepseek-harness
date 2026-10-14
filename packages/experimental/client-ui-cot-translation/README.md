---
description: "Machine-translate expanded reasoning while retaining the original text and saved results."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cot-translation

English | [中文](README.zh.md)

## Summary

Read expanded model reasoning in another language and switch back to its original text. Choose a translation service and target language from the Plugins panel. Translation sends displayed reasoning to the selected external service, which may include private code or conversation details. Original reasoning remains in the Session and model context.

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

Enable the [reasoning translation bundle](../cot-translation-bundle/README.md) in Plugins, then open a reasoning disclosure. The feature is absent until the bundle is enabled. Its bundle details provide staged Translation service and Target language controls; Save applies both preferences. Bing is the default provider, and `auto` targets the active UI language. An explicit language code such as `zh`, `en`, or `ja` overrides that choice.

View original and View translation share one always-visible action in the plugin's toolbar above the translated body. The plugin owns this action and its state; the Think title only controls the disclosure. Both views reuse the same compact Markdown renderer and typography, without changing the reasoning preview or making another request. Completed paragraphs and request-sized prefixes of long streaming paragraphs translate asynchronously; the unfinished tail stays original. A failure retains the original body and provides Retry; View translation remains disabled until the retry starts. Closing the disclosure or disabling the bundle cancels its requests.

For custom compositions, mount this plugin alongside the [translator service](../translator/README.md) and the ordinary Web GUI. The plugin's configuration fields are `provider` and `targetLanguage`; the generated [configuration catalog](../../../docs/config-catalog.md) owns their complete schema.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The browser registers a wrapper in Chat's `conversation.chat.reasoning.body` single Slot and renders original or translated text through the official `conversation.chat.reasoning.content` Factory. The wrapper owns its toolbar and view state, and passes its localized Markdown labels to the Factory; the Factory owns typography. The Host exposes cancellation-aware translation Remote methods. The Host supplies accepted provider and language preferences before the browser enables translation. Settings updates and reconnects refresh these preferences and the translator's request limit. A changed limit cancels and splits the expanded text again. One disclosure lifecycle controller serializes completed fragments, caches their translations while mounted, preserves whitespace and Unicode pairs when splitting long paragraphs, and excludes results after cancellation.

The browser binds each request to the disclosure's Session. The Host requires the accepted provider and any explicitly configured target language; `auto` uses the browser locale. The authenticated Client supplies source text and Session identity, and the Host does not verify that the source text belongs to that Session. The translator durably stores provider-independent request/result records and reuses completed results after collapse, reload or reopening the Session. The browser cache only optimizes the current display.

A saved result needs no activation. On an uncached inactive Session, the Host joins the ordinary Session controller activation and retries translation once through its existing writer. This uses normal preset startup hooks, resume markers, and interrupted-turn repair. Cancellation ends this caller's wait and prevents later translation dispatch; shared activation can still finish for other readers.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Translator service](../translator/README.md) — providers and network limits.
- [Chat rendering](../../client/ui-chat/README.md) — reasoning disclosure and display extensions.
- [Web Client Slots](../../../docs/subsystems/slots.md) — contribution lifetimes.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through optional independent paid Flash requests and normal Session activation on cache misses; the translator owns translation prompts, and the Session's preset owns startup context.

#### KV Cache effect

Translation records do not replace model input. Normal activation may append context or repair an interrupted turn, with the same cache effects as opening the conversation. The [translator](../translator/README.md#model-experience) owns the independent paid query's token and cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Google and Bing anonymous endpoints may reject requests or become unavailable; requests never fall back to another provider.
- Translation may change Markdown formatting or code examples. Original text remains available.
- An inactive subagent Session without a saved translation retains the original text and reports a translation failure; ordinary Session activation cannot restore subagent ownership.
- Collapsed previews remain original. Saved results belong to the Session; future format migrations retain experimental records on a best-effort basis.
- Provider reachability from mainland China requires network-specific verification.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
