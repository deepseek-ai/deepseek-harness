---
kind: upgrade-guide
description: "Undescribed pi-ai models inherit larger context and output capacities unless the provider configures explicit defaults."
---

# pi-ai default model capacities

English | [中文](guide.zh.md)

## Change

For models whose capacity is absent from both configuration and the installed catalog, `llm-pi-ai` raises `defaultContextWindow` from 262,144 to 1,000,000 tokens and `defaultMaxTokens` from 32,768 to 128,000 tokens. A larger assumed context window can delay automatic compaction. Explicit model capacities, catalog values, and provider defaults retain their precedence. The output-capacity fallback does not become a Harness request-level `maxTokens` default.

## Migration

1. Check the actual limits of custom endpoints. In the `llm-pi-ai` configuration in `cordis.patch.yml`, set `providers.<provider>.defaultContextWindow` and `providers.<provider>.defaultMaxTokens` when those limits differ. To retain the previous defaults, use `262144` and `32768` respectively.
2. For models with different limits on the same provider, set `contextWindow` and `maxTokens` on their `providers.<provider>.models` entries. An explicitly configured model `maxTokens` also supplies the Harness request default.
3. Reopen the profile configuration and confirm the saved numeric values. See the [provider configuration reference](../../../../packages/llm/llm-pi-ai/README.md).
