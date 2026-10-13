---
kind: upgrade-guide
description: "The pi-ai Azure provider route is renamed from azure-openai-responses to azure."
---

# Azure provider route rename

English | [中文](guide.zh.md)

## Change

The installed pi-ai catalog identifies the Azure provider as `azure` instead of `azure-openai-responses`. The `azure` route includes both Responses and Chat Completions models. The Responses API identifier remains `azure-openai-responses`, and the `AZURE_OPENAI_*` environment variables keep their names. Configurations and model selections that use the old provider key no longer resolve the Azure catalog.

## Migration

1. In the `llm-pi-ai` configuration in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` or another supplying layer, rename `config.providers.azure-openai-responses` to `config.providers.azure`. Preserve its existing fields and any `apiKeyEnv` reference.
2. Use catalog model IDs under `models`; map a custom Azure deployment name with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. The mixed catalog cannot infer a protocol for a model ID absent from the catalog. An explicit route-level `api` overrides every model on that route; it does not select the Azure provider.
3. Update explicit request/default provider selections to `azure`, and reselect an Azure model when continuing an existing Session. Configure the new Azure entry in Settings → Models if its key was stored for the old entry. Do not edit historical Session events.
4. Confirm that Settings → Models offers `azure` and lists the expected models, then send a short request using the configured deployment.
