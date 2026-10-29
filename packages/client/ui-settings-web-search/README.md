---
description: "The DeepSeek web-search settings page on the dsh web client's Plugins page: the Search and Fetch API switch, the API key, endpoint, and per-search limit."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-web-search

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Web search** in the Official group to switch between DeepSeek Messages search and the DeepSeek Search and Fetch APIs, and to set the selected API's key, endpoint, and per-search limit. The page stages what is typed and writes it only on save; the key is written through the credentials domain rather than the settings document, so its literal never rides a response. The page exists while the Host serves the `web-search-deepseek` namespace.

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

The **Web search** card in the Official group opens the page. **API key** starts blank on every load and reports only whether a key is configured; without one, it says that only conversations using a DeepSeek Account model can search, through the default endpoint, because those searches authenticate with the account sign-in; a blank draft keeps the stored key, and the control is disabled when the credential cannot be written from here, such as a key the process environment supplies. The API base URL and the active limit, **Max searches per request** for Messages or **Results per search** for the Search API, render the effective value, carry an **Overridden** badge with **Reset to default** once overridden, and save as a reset when emptied. Nothing is written until **Save**; leaving the page drops the drafts.

**Use the new Web Search API** defaults off, so search keeps using Messages and fetch keeps using local HTTP. Its hint links to the DeepSeek search and fetch guide for the new API's features and billing. Saving it on selects the DeepSeek Search and Fetch APIs together; saving it off clears both selections back to the deployment's defaults, or stores Messages search with local HTTP fetch when the deployment composes the APIs. The switch appears only while the Host also serves the `web` and `web-deepseek-api` namespaces. With the switch on, the page shows **Results per search** (an integer from 1 through 50, default 10) in place of the Messages-only **Max searches per request**, and invalid result counts block saving. The switch is disabled while an invalid edit or a failed save is staged, so a field it would hide stays visible. Each mode keeps its own API base when switching. The **Messages API base URL** and **Search / Fetch API base URL** labels identify the active protocol; their hints name the required prefix and appended operation path. One save writes the provider settings before the selection, so a refused section leaves the switch unsaved. See [web-search-deepseek](../../web/web-search-deepseek/README.md#use-this-package) and [web-deepseek-api](../../web/web-deepseek-api/README.md#use-this-package) for API behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `web`, `web-search-deepseek`, and `web-deepseek-api` namespaces through `ctx.configForms.get` and keeps one shared `SettingsFormModel` of `ui-primitives` per namespace in `WebSearchCardController`. The switch stages `searchProvider` and `fetchProvider` in `web`; a target equal to the composed value stages a reset instead. The key is the selection form's one secret control: its write goes to `remote.credentials.set` under the reference the selected API section's `apiKeyEnv` names (`DEEPSEEK_API_KEY` when it names none), and success is read back from `remote.credentials.describe`. The controller combines synchronous scope publications and reference switches into one credential read in the next microtask; scope refreshes also resynchronize credentials after a connection reset. Reference changes clear the previous credential state immediately. Host `credentials/reference-updated` events for the watched reference and writes trigger independent reads, including while an earlier read is pending. Only the latest read for the selected reference updates the card; a save uses its own readback result. Disposal stops queued reads and suppresses late answers. The page registers `WebSearchCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [credentials](../../credentials/README.md) — the credential-reference seam the key writes through.
- [web-search-deepseek](../../web/web-search-deepseek/README.md) — the Messages search provider whose namespace keeps the page served.
- [web-deepseek-api](../../web/web-deepseek-api/README.md) — the Search and Fetch API providers the switch selects.
- [web](../../web/web/README.md) — the provider selection the switch writes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Three fields of the namespace** — the provider's model, API version, and token budget stay at their composed values; the page edits the key, the endpoint, and the search budget only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
