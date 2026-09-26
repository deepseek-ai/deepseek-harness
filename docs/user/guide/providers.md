# Configure models

English | [中文](providers.zh.md)

This guide assumes you started the Web UI through the [root README](../../../README.md#run). Model changes take effect on the next request without restarting the server.

## Configure DeepSeek

Open **Settings → Models**. The DeepSeek card exposes one API-key field; enter the key and save it.

![The Models page: the DeepSeek card, with Add model provider below it](providers-models-page.png)

Keys are write-only. The page receives a redacted descriptor after saving, never the literal secret. The key is stored in `$DSH_HOME/.credentials.yaml`, while settings retain only its credential reference.

## Add a third-party provider

Choose **Add model provider**. The card opens on **Third-party model provider**: pick a provider dsh ships with — the list shows provider ids such as `anthropic`, `openai`, `moonshotai` for Kimi, or `zai` for GLM — enter its API key, and save. The installed catalog supplies the endpoint, protocol, and model list.

Providers that sign in with OAuth, such as Codex, are not supported here yet.

## Add a custom model API

Switch the card to **Custom model API** for a relay, a company gateway, a self-hosted server, or any provider absent from the installed catalog. Supply a lowercase Provider ID, base URL, API protocol, credential, and at least one model. The **API protocol** must be the one your gateway speaks, and the picker offers three: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages, stored in the active profile's `cordis.patch.yml` as `openai-completions`, `openai-responses`, and `anthropic-messages`. A provider speaks one protocol, so a gateway that serves two needs two providers.

![The custom model API form: Provider ID, display name, base URL, API protocol, and API key](providers-custom-form.png)

The Provider ID is permanent because requests, saved sessions, model defaults, and credential references use it. To rename a provider, add a new provider and delete the old one. The display name, base URL, protocol, credential, and models remain editable.

### Discover models

Under **Model catalog**, choose **Fetch available models** to ask the endpoint which models it serves. The request uses the base URL, protocol, and key currently in the form, or a saved provider's stored key, and the reply opens a searchable picker: search, tick the models you want, and choose **Add selected**. Nothing is stored until you save or create the provider.

Discovery reads the listing formats common gateways publish, but not every endpoint answers in one of them, so treat it as a convenience rather than a guarantee: when it fails or lists nothing, add the model ids by hand and they work just the same. A built-in provider is always answered from the installed catalog, even when its base URL points at a gateway, so fetch through a custom provider to see what the gateway really serves.

## Select a model

Configured providers appear in the model picker. Selecting a model also makes it the default for new sessions. A session that has already sent a request retains the model recorded in its own log.

If a saved default names a provider that was deleted, the composer displays **Select model** and blocks input until another model is selected.

## Advanced configuration

The generated [plugin configuration catalog](../../config-catalog.md) lists every supported field and default for every plugin; [`dsh-llm-pi-ai`](../../config-catalog.md#deepseek-aidsh-llm-pi-ai) is the provider section this page configures. The [`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.md) and [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.md) references own direct `cordis.patch.yml` configuration, catalog resolution, reasoning controls, credentials, and adapter errors.

::: tip Additional settings
The Models page exposes the API key, display name, base URL, API protocol, and each model's id, display name, context window, max output tokens, and input types. Configure reasoning effort levels, request-compatibility switches, headers, timeouts, and retry policy in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, the same document the page writes. Edit it directly, or, when the browser runs on the same machine as the server, open it with **Open configuration file** in the Settings header; the adapters re-read it on the next request, so nothing needs a restart. The subsections below cover the fields most gateways need.

For the standard Web UI launch with `dsh web`, `<profile>` is `web`, so the path is `$DSH_HOME/profiles/web/cordis.patch.yml`. If you launch a custom profile, use the name selected at startup instead.
:::

### Image input

In **Settings → Models**, edit the provider, open **Customized settings**, and expand the model's **Model options**. **Input types** occupies its own row below the capacity fields. Select **Image** for a model that accepts images, and save. **Text** starts selected for a new custom model with no inherited image capability. At least one type must remain selected; select Image before clearing Text for an image-only model.

The checkboxes save `input` for pi-ai models and `inputModalities` for the direct DeepSeek adapter. You can also edit the model in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; for example, this custom pi-ai provider declares one text-only model and one vision model:

These examples show config fields inside a profile patch. A Cordis config override replaces the complete entry config; preserve other providers and fields when editing an existing override.

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        models:
          - id: legacy-chat
          - id: vision-preview
            input: [text, image]
```

Pi-ai's `input` accepts `text` and `image` and applies to that model alone. An explicit nonempty selection takes priority. An omitted or empty `input` inherits the installed catalog's input types, then the route's `defaultInput`, which defaults to `[text]`. The checkboxes display these inherited values without saving an override when you merely open the row.

DeepSeek treats an omitted `inputModalities` as text-only and rejects an empty list. Clearing Image also removes that model's `imagePixelBudget` and `imageMaxBytes`, because DeepSeek rejects image limits on a text-only model. Set those limits again if you later enable images and need custom limits.

To restore inheritance after editing the checkboxes, remove the model's `input` or `inputModalities` field from `cordis.patch.yml`. **Restore defaults** removes the entire model-catalog override, including other model edits, so use it only when you want to restore the whole catalog.

If every model you entered by hand takes images, set the fallback once on the route instead of on each of them:

```yaml
- id: llm-pi-ai
  config:
    providers:
      vision-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://vision.example/v1
        defaultInput: [text, image]
        models:
          - id: first-model
          - id: second-model
```

`defaultInput` is a fallback, not an override, and defaults to `[text]`: on a built-in provider it answers only for models its catalog does not describe, so it never removes images from a catalog model that has them. Narrow one of those with that model's own `input`. When a built-in provider has no explicit `models` list, write it under `modelOverrides`, keyed by model id:

```yaml
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        modelOverrides:
          claude-sonnet-4-5:
            input: [text]
```

In pi-ai configuration, every list must name at least one modality except a model's own `input`, where an empty list means the same as omitting it. An unknown modality is refused wherever it is written.

Both fields state a claim about your endpoint rather than checking it. A model that declares images its endpoint does not serve is not caught here; the provider rejects the request instead.

### Reasoning effort

The model picker offers an **Effort** menu for a model that declares reasoning levels. A built-in provider's models inherit their levels from the installed catalog. A model you enter by hand declares none, so the Effort entry does not appear in the menu and the endpoint's own default decides whether the model thinks. Declare the levels with `reasoningEfforts` in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        reasoning: high
        models:
          - id: my-reasoner
            reasoningEfforts:
              off:
              high: high
              max: max
```

Each key is a level the menu offers, and its value is the spelling sent on the wire as `reasoning_effort`, so `max: xhigh` renames a level for a gateway with its own vocabulary. Only `off` may stay empty, because for most endpoints not thinking is the parameter's absence. The route's `reasoning` is the level used while a session has picked none; choosing an effort in the picker saves it, with the model, as the default for new sessions.

An `off` left empty sends nothing, which only stops a model that thinks on request; an `off` given a value sends that value as `reasoning_effort` instead. A model that thinks unless told not to — DeepSeek V4 behind an OpenAI-compatible gateway, for example — needs `compat.thinkingFormat: deepseek`, which makes `off` send `thinking: {type: disabled}` and every other level send `thinking: {type: enabled}` beside the effort:

```yaml
        models:
          - id: deepseek-v4-pro
            compat:
              thinkingFormat: deepseek
            reasoningEfforts:
              off:
              high: high
              max: max
```

A built-in provider's model whose gateway does not reason loses its levels with `reasoningEfforts: false` under `modelOverrides`; selecting an effort for it is then refused as `UNSUPPORTED_REASONING_EFFORT`. DeepSeek's own route needs none of this: its models already offer `off`, `low`, `high`, and `max`, and `llm-deepseek.reasoningEffort` sets the default the picker starts from:

```yaml
- id: llm-deepseek
  config:
    reasoningEffort: max
```

### Request compatibility

A gateway can hold a working key at a reachable address and still refuse every request. pi-ai decides the shape of a request — which role carries the system prompt, which field caps the output, how a thinking level travels — from the endpoint's URL, and an address it does not recognize is addressed as though it were OpenAI itself. Most OpenAI-compatible gateways refuse at least one thing OpenAI accepts.

Two account for most of it. A model that declares reasoning has its system prompt sent as `role: "developer"`, which many gateways reject outright, and the output cap is sent as `max_completion_tokens`, which a server that only knows `max_tokens` refuses. The form has no field for either; correct them on the route in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: my-model
```

A route's `compat` is the default for its models, and a model's own wins field by field, so one model can be corrected without restating the route:

```yaml
        models:
          - id: my-model
          - id: my-reasoner
            compat:
              thinkingFormat: deepseek
```

What neither sets keeps the installed catalog's value for that model, and what the catalog does not describe falls to pi-ai's detection. Give every switch you name a value: a key left empty (`supportsDeveloperRole:`) is refused rather than ignored, because an empty value would erase what the catalog knows while saying nothing in its place. A name no protocol accepts is refused too, and the message lists the ones that are available.

Each switch belongs to the protocols that declare it, so a switch valid on one `api` may be refused on another — the message names what that protocol does offer. Like `input` above, a switch states a claim about your endpoint rather than checking it: setting one your gateway does not actually need simply sends a different request.

Every switch, its accepted values, and the protocols that take it are listed under `PiAiCompatProfile` in the [generated `dsh-llm-pi-ai` configuration reference](../../config-catalog.md#deepseek-aidsh-llm-pi-ai) — which is derived from the source, so it cannot fall behind what the adapter accepts.

## Troubleshooting

- **`MISSING_CREDENTIAL`** — Store the provider key through the Models page or supply the referenced environment variable.
- **`UNKNOWN_MODEL`** — Select a configured model or add the missing model to the custom provider.
- **Fetching available models returns 401** — Check the key. Model discovery calls the OpenAI-compatible `GET /models` endpoint; enter models manually for endpoints that do not provide it.
- **Fetching available models reports neither a `data` array nor a `models` object** — The endpoint's listing is in a format discovery does not read. Enter the models by hand.
- **The gateway refuses every request although the key and URL are right** — Its request shape differs from OpenAI's. Start with `compat.supportsDeveloperRole: false` and `compat.maxTokensField: max_tokens` on the route.
- **Only reasoning models fail** — pi-ai sends their system prompt as the `developer` role, which the gateway rejects. Set `compat.supportsDeveloperRole: false`.
- **The Effort menu does not appear for a model you entered by hand** — It declares no levels. Add `reasoningEfforts` to the model in `cordis.patch.yml`.
- **`off` does not stop a DeepSeek model from thinking** — An empty `off` sends no reasoning field at all, and an endpoint that thinks by default keeps thinking. Set `compat.thinkingFormat: deepseek` on the model or the route.
- **A compat switch is refused as having no value** — A key written with nothing after the colon. Give it a value, or remove the key to keep the installed catalog's.
- **An image is refused before sending** — The model declares no image modality. Give a custom provider's model `input: [text, image]`; on DeepSeek's own route, select an image-capable entry from the configured catalog (`deepseek-flash` by default) and confirm that your gateway serves that model with image input.
- **The provider rejects a request carrying an image** — The model declares images its endpoint does not actually serve. Remove `image` from whichever list granted it — the model's `input`, or the route's `defaultInput` — then start a new session: the attached image stays in the session log, so the same request repeats until the session moves off it.
