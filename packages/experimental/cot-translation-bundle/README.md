---
description: "Enable machine translation of displayed reasoning from the Plugins page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cot-translation-bundle

English | [中文](README.zh.md)

## Summary

Translate expanded reasoning into the interface language or another chosen language. Enable Reasoning translation on the Web or Desktop Plugins page; shipped profiles leave it disabled. Bing is the default provider, and Google is available in the bundle settings. Original reasoning remains available and stays unchanged in the Session and model input.

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

Open Plugins and enable Reasoning translation in the Official group. Open its details to select a translation service and target language. `auto` follows the interface language; an explicit language code such as `zh`, `en`, or `ja` overrides it. Save applies the preferences.

Expand a Think row to start translation. The row translates completed paragraphs and request-sized prefixes of long streaming paragraphs while retaining the unfinished tail. View original in the translation toolbar switches the expanded body to the source; View translation switches it back. A failed translation leaves the original visible and offers Retry. Disabling the bundle removes its controls and cancels pending calls. Successful translations remain saved in the Session and are reused when the same request is reopened, the page reloads, or the Host restarts.

The selected service receives the expanded reasoning, which can contain private code and conversation details. Google and Bing send source text in POST request bodies. Bing and Google require no additional login or API key, but neither anonymous endpoint guarantees availability or free quotas. Eligible native `deepseek-flash` routes appear as explicit paid choices using the configured DeepSeek Account or Official API credentials. Each uncached fragment issues one independent query with thinking disabled. Reopening reuses saved results; changing provider, language, source or recipe may require another billed query. The model ID is matched without a version number, and pi-ai routes are excluded. Provider failure never sends the text to another service automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The bundle patch inserts `translator` and `cot-translation`, selecting Bing and the interface language. The translator owns provider protocols, network limits, and shared persisted requests and results; the GUI consumer owns settings, paragraph scheduling, and a local cache for the current display. The GUI reuses saved results directly and joins normal Session activation when a new translation needs its existing writer. Its generated Remote contribution is mounted only while the bundle is enabled. The translation wrapper and Chat's default Body entry both call the official reasoning Content Factory.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Text translation subsystem](../../../docs/subsystems/translation.md) · [Translator service](../translator/README.md) · [GUI consumer](../client-ui-cot-translation/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through optional independent paid Flash requests and normal Session activation on cache misses; the translator owns translation prompts, and the Session's preset owns startup context.

#### KV Cache effect

Translation records leave original reasoning intact; normal Session activation and optional paid queries have the cache effects described by the [GUI consumer](../client-ui-cot-translation/README.md#model-experience).

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Collapsed summaries remain in the original language. Translation starts when the reader expands the reasoning body; it may change Markdown or code formatting. Original always remains accessible.
- Anonymous Google and Bing browser endpoints may fail, rate-limit requests, or change their response formats. Mainland China connectivity depends on the deployment's network and proxy configuration. Successful translations remain in the Session after collapse, bundle removal, or restart. Experimental records have best-effort retention across future Session-format migrations.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
