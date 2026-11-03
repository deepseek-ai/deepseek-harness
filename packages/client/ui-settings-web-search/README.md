---
description: "The web search and fetch settings page on the dsh web client's Plugins page: the Search and Fetch provider menus, the DeepSeek Search API result count, and legacy Messages search settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-web-search

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Web search and fetch** in the Official group to choose the providers web search and web fetch use, set the Search API result count, or configure legacy Messages search. The DeepSeek Search and Fetch APIs take no credential settings here: they use the conversation's DeepSeek account or a DeepSeek API key. The page writes only on save; a legacy key goes through the credentials domain. The page exists while the Host serves the `web` namespace; each official provider's controls appear only while the Host serves that provider's namespace.

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

The **Web search and fetch** card in the Official group opens the page. It has a **Web search provider** section and a **Web fetch provider** section, each with a provider menu directly under its title. A menu lists every provider the Host registers, including providers that plugins register, so a newly installed provider needs no change to this page; [Add another provider](../../web/web/README.md#adding-a-provider) shows how to mount one in a profile. The official ones come first while registered: the Search menu lists **DeepSeek Search API** (`deepseek-search-api`) followed by **DeepSeek (legacy)** (`deepseek-official`), and the Fetch menu lists **Direct fetch** (`http`) and then **DeepSeek Fetch API** (`deepseek-fetch-api`); every other provider follows in registration order and shows its registered title or id. The shipped composition selects DeepSeek Search API for Search and Direct fetch for Fetch, and a selection stored in settings or composed by the deployment still applies; opening the page writes nothing. Each menu has no label of its own; its accessible name is its section title followed by the selected provider, such as **Web search provider DeepSeek Search API**. A selected id the Host does not register appears as an extra **(not loaded)** entry and stays selected. While the deployment composes no provider for a capability, its menu starts with **Automatic**, which clears the stored selection so the Host chooses again. Selecting the deployment's composed provider clears the stored selection instead of writing a copy. When the provider list cannot be read, each section says its menu may be incomplete and offers **Retry**; the menus keep the last list read, or only the selected ids before any list arrives. Under each menu, the section shows the `description` the selected provider registered, in the active language, as plain text; a provider that registers none, or a selected id the Host does not register, shows no description. The official providers' descriptions state each one's credentials, charges, model calls, reachable addresses, and content limits, and Direct fetch's ends by suggesting DeepSeek Fetch API as plain text. A plugin provider's section adds, after its description, that it is configured in that plugin's own settings.

Under **Web search provider**, DeepSeek Search API adds a link to the DeepSeek search and fetch guide after its description, and a gray panel below the menu holds **Results per search** (an integer from 1 through 50, default 10; invalid counts block saving). The DeepSeek Fetch API section shows its provider menu and description. Both APIs follow the DeepSeek credential of the conversation, and their own endpoint fields are YAML-only ([web-deepseek-api authentication](../../web/web-deepseek-api/README.md#authentication)). A provider with no settings on this page, such as DeepSeek Fetch API, Direct fetch, or a plugin provider, shows no panel. Every control sits directly in its section; nothing is collapsed.

**DeepSeek (legacy)** shows its API key, independent Messages Base URL, and **Maximum searches per request** (`maxUses`, a positive integer, default 5) in the same panel layout. The key writes the `web-search-deepseek.apiKeyEnv` reference (`DEEPSEEK_API_KEY` by default); endpoint and limit writes stay in `web-search-deepseek`, separate from API settings. Switching away drops an unsaved key but preserves endpoint and limit settings.

Value fields render the effective value, carry an **Overridden** badge with **Reset to default** once overridden, and save as a reset when emptied; a value equal to the deployment default saves as an override. The provider menus are disabled while an invalid edit or a failed save is staged, so a field the change would hide stays visible.

A staged edit to a hidden provider's field is kept and saved. One save writes the provider settings before the selection, so a refused section leaves the selection unsaved. Nothing is written until **Save**; leaving the page drops the drafts. See [web-deepseek-api](../../web/web-deepseek-api/README.md#use-this-package) for API behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `web`, `web-search-deepseek`, and `web-deepseek-api` namespaces through `ctx.configForms.get` and keeps one shared `SettingsFormModel` of `ui-primitives` per namespace in `WebSearchCardController`. The menus stage `searchProvider` and `fetchProvider` in `web`; a target equal to the composed value stages a reset instead, and so does the **Automatic** entry, which the menu offers while the composed `base` has no value for that field. The provider list comes from `remote.web.listProviders`, which keeps registration order; the controller moves the registered official providers to the front in its fixed order and keeps the rest in Host order. The list is read at construction, on each `web/providers-changed` event, on `connection/reset`, and when the `web` namespace becomes served; only the latest read publishes, a failed read keeps the previous list and sets the snapshot's `providersFailed` until a later read succeeds, and before the first successful answer a menu holds only the selected id. The face's `retryProviders` re-reads through the same sequence and disposal checks. The `web-deepseek-api` form stages only `count`. The selection form's secret control is `legacyApiKey`, which addresses `web-search-deepseek.apiKeyEnv`. Its draft records the reference the control addressed when it was typed; on every republish the draft is dropped when the page no longer shows the control or the reference changed. A save fixes the draft reference when the selection form plans its writes, so a key write planned before its provider disappears still writes under that reference. A write goes to `remote.credentials.set`, and success is read back from `remote.credentials.describe`, which one read asks for the current reference and the written one. The controller combines synchronous scope publications and reference switches into one credential read in the next microtask; scope refreshes also resynchronize credentials after a connection reset. A reference change clears the credential state immediately. Host `credentials/reference-updated` events for the watched reference and writes trigger independent reads, including while an earlier read is pending. Only the latest read updates the card, and only while its reference is unchanged; a save uses its own readback result. Disposal stops queued reads and suppresses late answers. `WebSearchCard` renders the provider menus with one local menu button over the `Menu` primitive and the legacy fields with `SettingsSecretField` and `SettingsValueField`. The page registers `WebSearchCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed([web])`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [credentials](../../credentials/README.md) — the credential-reference seam the legacy key writes through.
- [web-deepseek-api](../../web/web-deepseek-api/README.md) — the Search and Fetch API providers whose result count the Search section edits.
- [web](../../web/web/README.md) — the provider selection and provider list the menus use.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Automatic selection reads only the deployment composition** — a menu offers it when the composition layer sets no provider for that capability. While automatic selection applies, the Host's `DSH_WEB_SEARCH_PROVIDER` or `DSH_WEB_FETCH_PROVIDER` environment variable picks the provider instead, and the page does not show that choice. Without either, automatic selection with more than one usable registered provider makes each operation fail with `WEB_PROVIDER_AMBIGUOUS`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
