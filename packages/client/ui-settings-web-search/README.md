---
description: "The DeepSeek web-search provider's settings page on the dsh web client's Plugins page: its API key, endpoint, and per-request search budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-web-search

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Web search** in the Official group to set the provider's key, endpoint, and how many times one request may search. The page stages what is typed and writes it only on save; the key is written through the credentials domain rather than the settings document, so its literal never rides a response. The page exists while the Host serves the `web-search-deepseek` namespace.

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

The **Web search** card in the Official group opens the page. **API key** starts blank on every load and reports only whether a key is configured; a blank draft keeps the stored key, and the control is disabled when the credential cannot be written from here, such as a key the process environment supplies. **Endpoint** and **Max searches per request** render the effective value, carry an **Overridden** badge with **Reset to default** once overridden, and save as a reset when emptied. Nothing is written until **Save**; leaving the page drops the drafts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `web-search-deepseek` namespace through `ctx.configForms.get` and keeps the staged form in `WebSearchCardController` over the shared `SettingsFormModel` of `ui-primitives`, with the key as the form's one secret control: its write goes to `remote.credentials.set` under the reference the section's `apiKeyEnv` names (`DEEPSEEK_API_KEY` when it names none), and success is read back from `remote.credentials.describe`. The controller re-reads the credential when the scope changes and when the Host reports `credentials/reference-updated` for the watched reference, since a key written on the Models page changes no settings section. The page registers `WebSearchCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the page renders.
- [credentials](../../credentials/README.md) — the credential-reference seam the key writes through.
- [web-search-deepseek](../../web/web-search-deepseek/README.md) — the provider that registers the namespace.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Three fields of the namespace** — the provider's model, API version, and token budget stay at their composed values; the page edits the key, the endpoint, and the search budget only.
- **Runtime invariant:** No companion is published. The page holds no owned relationship of its own: what it shows derives from the settings mirror and the credentials domain, and what it writes the Host validates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
