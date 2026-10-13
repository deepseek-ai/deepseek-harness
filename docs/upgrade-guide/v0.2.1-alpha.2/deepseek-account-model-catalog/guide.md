---
kind: upgrade-guide
description: "The DeepSeek account route no longer accepts a models catalog; the account listing supplies its models and modelOverrides adjusts them."
---

# DeepSeek account models come from the account listing

English | [中文](guide.zh.md)

## Change

The `deepseek-account` route previously read its model catalog from the `models` field of the `llm-deepseek-account` entry, which the Models page could edit for the account. The route now lists models from the account's `GET /models` endpoint, serves the built-in catalog until a listing loads, and accepts per-model adjustments only through `modelOverrides`; the Models page no longer offers an editor for this route. A listed model can require a newer DeepSeek Harness; such a model is hidden, and a request for it fails with `CLIENT_UPGRADE_REQUIRED`. A `models` field left in the entry, including one saved by the earlier Models page editor, stops the plugin at load with `llm-deepseek-account: models is no longer configurable`, and Desktop and Web show no account models until the field is removed. Signed-in accounts without a saved catalog need no action.

## Migration

1. Open `$DSH_HOME/profiles/<profile>/cordis.patch.yml` and find the entry with `id: llm-deepseek-account`.
2. Delete its `models` field. For each model whose fields you changed, move only the changed fields under `modelOverrides.<model id>`:

   ```yaml
   - id: llm-deepseek-account
     config:
       modelOverrides:
         deepseek-flash:
           maxTokens: 131072
   ```

3. Restart DeepSeek Harness, sign in to the DeepSeek account, and confirm that the model selector lists the account models and the Models page shows the account as signed in. An override the listed model rejects, or one that names an unknown model, appears as the account's diagnostic on the Models page.
