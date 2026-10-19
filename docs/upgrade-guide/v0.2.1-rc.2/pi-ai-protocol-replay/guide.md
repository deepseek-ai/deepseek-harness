---
kind: upgrade-guide
description: "pi-ai 1.3.0 changes provider protocols, reasoning choices, history replay, and invalid tool-argument handling."
---

# pi-ai 1.3.0 protocol and replay changes

English | [中文](guide.zh.md)

## Change

The pi-ai upgrade from 1.1.0 to 1.3.0 changes these defaults. Explicit profile overrides still win.

| Route or behavior | New behavior |
|---|---|
| `kimi-coding` | Uses `openai-completions` at `https://api.kimi.com/coding/v1` instead of `anthropic-messages` at `/coding` |
| `opencode`, `opencode-go` | Endpoints replace `/zen` with `/inference`; `/go` and `/v1` suffixes remain model-specific |
| Xiaomi MiMo catalogs, including token-plan routes | Offer only `off` and `high` reasoning |
| `kimi-coding/kimi-for-coding-highspeed` | Does not offer reasoning `off` |
| Assistant reasoning history | Outgoing requests omit thinking from another provider, API, or model instead of converting it to text; degraded replay without native metadata also omits thinking |
| Invalid completed tool arguments | The attempt fails with `MALFORMED_RESPONSE`; it executes no tools and publishes no successful replay state. The default normal retry policy excludes this code |

Stored history is retained. Returning to the original model restores its valid native replay metadata. Output truncated by the token limit still drops incomplete tool calls and can continue normally. Credentials do not require migration.

## Migration

1. Review `providers.<provider>.baseURL`, `api`, and `compat` overrides in `cordis.patch.yml`. For overrides that follow the upstream Kimi Coding endpoint, use the Completions protocol and `/v1` path. Custom gateways must explicitly retain their actual protocol and path. Update OpenCode URLs to `/inference` where applicable. Omit overrides when catalog defaults are intended.
2. Replace unsupported reasoning selections in profiles, presets, and Sessions with a level shown by the current model metadata.
3. Put facts needed across model changes in user messages or normal assistant replies; do not rely on prior private reasoning becoming visible text.
4. For `MALFORMED_RESPONSE`, inspect the reported invalid arguments and correct the model or gateway output. Verify the affected route with a short prompt and a tool call. See the [configuration reference](../../../../packages/llm/llm-pi-ai/README.md).
