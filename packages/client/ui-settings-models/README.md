---
description: "Models settings and product-onboarding plugin for the dsh web client: provider rows, API-key management, model lists, and the DeepSeek first-run dialogs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-models` is the Models settings page of the dsh web client: users configure API keys (stored write-only under the profile's credential reference), edit each provider's model list, and hand-declare custom pi-ai routes, with provider rows and one editor card at a time. The page joins the provider directory, the settings document, and the credential descriptions into one shared snapshot, so a row's state stays consistent across all three. It also walks first-run users through two ordered dialogs — a versioned internal-testing notice and the conditional official-DeepSeek credential step.

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

Saving credentials or a custom provider preserves the selected model. The user can select an available model from the composer.

DeepSeek Account appears first and DeepSeek second in the provider list; third-party providers retain their directory order.

Open the Models page from the Settings navigation to see every configured provider as a row. A whole-section provider whose key is not configured anywhere renders as its open setup card instead, but only in the first-run posture and only until the user closes that card. Each card kind owns its own open state, so closing one never discards a draft in another.

A provider with a stored catalog error remains visible with its diagnostic and edit/delete actions. Add actions are offered only for registered settings namespaces, so an unavailable namespace cannot leave a button that opens no editor. A rejected save leaves the editor open and displays the Host diagnostic.

Host configuration `credentialOnboarding` defaults to `true`. The Electron preload marker suppresses automatic credential onboarding and the Web welcome notice; Models settings and explicit API-key editing remain available. The [account plugin](../ui-settings-account/README.md#desktop-onboarding) owns the Desktop introduction. Other native shells can disable only the credential step with `credentialOnboarding: false`. Host publishes this public boolean through `webserver/index-inject`, and Client validates it before registering dialogs. It is page initialization data, not a durable completion marker.

### API keys

API-key inputs start empty and use `autocomplete="new-password"` to ask browsers not to autofill saved login passwords.

The primary field on an editor card is a single **API key** input — the page never asks for an environment-variable name. A typed key stores write-only through `credentials.set` under the profile's reference, deriving `<ROUTE>_API_KEY` when the profile has none, and the pi-ai profile records that derivation as `apiKeyEnv`, so `cordis.patch.yml` never carries a key value. Leaving a new pi-ai provider's key blank saves a reference-free profile and preserves provider-native authentication (for example the Bedrock credential chain or Vertex ADC). A row labels API-key state with a green solid dot only when a referenced credential is confirmed configured, and with a red solid dot only when a named reference is confirmed missing. A successful Apply emits a local accessible status message without echoing secret material.

### Editing a provider

The collapsed 自定义设置 fold carries the curated extras: `baseURL` for both families (the deepseek placeholder shows the public endpoint), each adapter's model catalog, and the **display name** and **API protocol** of a pi-ai route the adapter does not ship. Profile `headers` remain deployment configuration in `cordis.patch.yml` or Cordis config and have no Models-page editor. The Provider ID stays fixed: it is the settings key, the name every other namespace and every logged session references, and the stem of a credential reference the page cannot read back to move. Reasoning effort is deliberately not among the editable fields: it is a per-model capability, so a provider-scoped control could only be set to a value some models reject. Each model row edits `id`, optional display `name`, optional `contextWindow`/`maxTokens`, and input types; unrelated model fields survive edits.

The DeepSeek card edits the `llm-deepseek` endpoint, credentials, and model catalog. It uses Messages, with the default endpoint placeholder `https://api.deepseek.com/anthropic`.

Expand **Customized settings → Model options** to edit each model. Both provider families share the same row layout, labels, and icons: context window and max output tokens occupy two columns, and **Input types** occupies a separate row with **Text** and **Image** checkboxes. A row without an input declaration displays the installed model’s input types, then the provider default, then Text. Known pi-ai providers load their installed catalog without endpoint I/O; opening a row does not write an override. Explicit input selections take precedence, including text-only overrides of vision models. Checkbox edits save the selected types, with at least one type required. DeepSeek writes `inputModalities`; pi-ai writes `input`. Unchecking Image for DeepSeek also removes `imagePixelBudget` and `imageMaxBytes`, because the adapter rejects those limits without image input. Clearing the input field in `cordis.patch.yml` restores adapter inheritance; **Restore default models** resets the entire catalog override. Declare only input types the upstream model can actually process.

### Adding and deleting providers

**Add model provider** is the one entry to the add card, offered while any editor-backed settings namespace is mounted and enabled while either mode below can proceed. The card opens on a segmented mode switch with a one-line purpose beneath it: **Third-party model provider** carries the dormant-directory provider select over the provider editor — a bare-mounted `llm-pi-ai` offers its whole installed catalog before any route exists — and **Custom model API** carries the create form for a route pi-ai does not ship: a relay, a self-hosted server, or any other OpenAI- or Anthropic-compatible endpoint. A mode is offered only while its namespace is mounted; with one mode the card shows that form alone under the mode's name, and a mode whose namespace has nothing left to adopt or no protocol to declare is disabled with the reason as its hover text. A panel mounts the first time its mode is shown and stays mounted, hidden, while the card is open and its mode stays offered, so switching modes discards neither draft; the switch locks while either panel has a write or an endpoint interrogation in flight, since a switch underneath one would orphan its answer. Each tab controls its panel through ids, and closing either panel forgets the catalog draft's target. The custom form asks for a unique **Provider ID**, an endpoint, a protocol, and at least one uniquely-identified model, because nothing can default those. The protocol picker names each protocol by its product name — OpenAI Chat Completions, OpenAI Responses, Anthropic Messages — while the stored value stays the schema identifier; a protocol the adapter adds before this page names it shows that identifier. The endpoint placeholder follows the selected protocol: OpenAI Chat Completions and Responses show `https://gateway.example/v1`, while Anthropic Messages shows `https://gateway.example` because its SDK appends `/v1/messages`. Changing the protocol preserves any address already entered. The endpoint must be a parseable HTTP or HTTPS URL; localhost, IPv4 and IPv6 literals, and custom ports remain valid. A syntax error blocks both discovery and creation at the field, while a request failure remains a separate provider error. **Fetch available models** asks the `llm/discoverModels` Remote about the endpoint the form shows, so adding a provider is one pass instead of save-then-return; the reply opens a searchable picker rather than being written, and nothing is written until **Add selected**. Each candidate displays its original model id in a monospace font to distinguish models with the same name. Rows stay on one line; hovering reveals the model name, falling back to the full id when no name is supplied. Selection and configuration retain the original model id. Each selected candidate copies its id, display name, context window, output-token cap, and disclosed input types into the editable row when disclosed, while an existing row retains its user-tuned values. Search matches model ids and optional display names without clearing hidden selections. **Select all** adds the visible results, while **Deselect all** clears the entire selection so hidden results cannot be adopted accidentally. A row is deletable only when the user layer alone carries it (removal restores the composition base), and its confirmation dialog names the provider.

### First-run dialogs

After the versioned notice step completes, the DeepSeek step projects first-run readiness from the same joined snapshot. ANY provider the user can already reach ends it without rendering; only a user with none is asked for the official DeepSeek key. Configure later completes only this coordinator pass, and an absent adapter, inactive route, failed join, read-only deployment, or unusable capability completes the step without rendering — Models remains the diagnostic surface.

### Extension slots

The section declares two seats for plugins distributed outside this repository, typed in [`src/client/slot-contract.ts`](src/client/slot-contract.ts) and exported from `./client`. `settings.models.provider-card` (keyed) renders inside every card that shows a directory row — a saved row's card, its first-run setup posture, and the add-provider draft — dispatched with `entryKey = settingsNs` and owner props carrying the row's `ConfigurableProviderView`, its configured state, and its confirmed api-key credential state, so one registration under an adapter family's namespace receives every card of that family, hand-declared routes included; the hand-declared draft card has no directory row yet and dispatches nothing until saved. `settings.models.footer` (list) renders after the rows and the add controls. A registrant activates through `ctx.slots.inject` with a type-only import of this package's `/client` entry; without registrants both seats render nothing.

The Models page includes **DeepSeek Account** (`deepseek-account`, **DeepSeek 账号** in Chinese). Its editor exposes the shared DeepSeek model catalog without API-key or base-URL inputs, and saves that catalog under the account route's own settings section (`llm-deepseek-account` by default), so an account edit never rewrites the `llm-deepseek` section the official route reads. The account row is hidden when its available model catalog is empty, including before sign-in and after sign-out; it returns when account models become available.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page never holds a full settings section: it holds only the REDACTED descriptor, so every edit lands as `settings.mutate` path ops against the stored section — a set per changed field, an unset per cleared one, and a single unset for a deleted provider row.

### Validation

A typed API key is judged on its own field: after trimming, it must be non-empty and every character must be printable ASCII (`[\x21-\x7E]`), which is exactly what an HTTP header value can carry — the twin of `normalizeApiKey` in `@deepseek-ai/dsh-llm`, mirrored here because the source-plane split forbids importing it. A value matching a pasted `NAME=value` environment line or wrapped in matching quotes is refused as the same format failure. Empty ids, duplicate ids, empty explicit names, and unreadable, non-positive, or fractional capacities fail before any write. DeepSeek's `models` is one replace-by-value array: the editor shows inherited effective rows until the first model edit materializes the complete array in the user layer, while reset unsets that override.

### Concurrency and credentials

Each settings write carries the card's current `revision`, so a concurrent write from another tab or an external `cordis.patch.yml` edit is refused as `settings/conflict`. After settings commit, the card adopts the returned redacted user subtree and revision before storing the credential, so a failed credential stage retries only that stage. Deletion removes a configured, writable credential only when the profile names the page's derived `<ROUTE>_API_KEY` target, then unsets the profile; both operations are idempotent. Once loaded, the page subscribes to forwarded `settings/document-updated`, `credentials/reference-updated`, and `llm/adapters-updated` owner events, plus local `connection/reset`, so external edits converge without polling.

### Onboarding coordinator

The notice step owns its exact copy in `src/client/locales.ts` and its acknowledgement version in `src/onboarding-copy.ts`; on loopback it compares and writes `ui-settings-general.welcomeNoticeVersion` through the shared configuration form, and only an explicit Continue records the current version. A non-loopback browser cannot use that Host-only namespace, so acknowledgement is process-local and the notice returns after reload. The DeepSeek step targets `deepseek-official` in `llm-deepseek` and renders the existing `ProviderEditor` in credential-only mode inside the shared onboarding modal; `credentials.set` stays the only secret write, and no provider settings are changed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings base, the seams this page joins, and the design rationale.

- [ui-settings](../ui-settings/README.md) — the domain base whose scope and schema services this page builds on.
- [settings](../../settings/README.md) — the durable user-settings seam and its file provider.
- [credentials](../../credentials/README.md) — the credential-reference seam this page writes keys through.
- [llm](../../llm/README.md) — the adapter registry whose providers this page configures.
- [Web config plane](../../../.agents/notes/archived/architecture/2026-07-30-web-config-plane.md) — the hand-written editor's design rationale.

-----

The `settings.models.sign-in` slot lets account login offer a choice before the credential editor; without a contributor the editor renders directly. Closing the account choice completes the whole onboarding step. Explicit reopening from the account menu enters the same editor even when a provider is already configured.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the editor's field coverage and the page's reach; they are current package constraints, not a settings roadmap.

- **Only the API key and curated fold fields are editable on the card** — the hand-written editor traded schema-generic field coverage for the mockup layout. Retry policy, timeouts, DeepSeek model descriptions, and other advanced fields remain in `cordis.patch.yml`; existing model fields the editor does not show are preserved.
- **Credential cleanup is intentionally narrow** — deleting a row removes the configured, writable credential only when its reference is the exact `<ROUTE>_API_KEY` target this page derives. Custom references, environment credentials, and unidentifiable targets are retained because the row cannot prove ownership of them.
- **Only pi-ai routes can be hand-declared** — the custom-API form writes into `llm-pi-ai`, the one namespace whose profiles describe a whole provider. A `llm-deepseek` route is a composition fact, not something this page can create.
- **The catalog select lists route identifiers** — `moonshotai`, `zai`, and the other pi-ai catalog ids appear as they are, with no product names, aliases, or search. A searchable picker with the custom form as one pinned entry would let the mode switch go; it needs the directory to carry display names first.
- **Interrogation covers OpenAI-compatible and Anthropic Messages endpoints** — OpenAI protocols accept a standard `data` array or an enriched `models` map, while Anthropic uses its native model-listing route; every other protocol reports that it cannot be asked and its models are entered by hand.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A nav-entry-only section plugin rendering a fixed empty content column — it emits no cordis events and owns no cross-plugin mutable relation.
