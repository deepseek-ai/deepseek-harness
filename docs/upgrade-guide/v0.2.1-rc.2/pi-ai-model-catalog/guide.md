---
kind: upgrade-guide
description: "The pi-ai 1.3.0 catalog removes model IDs and lowers some model capacities."
---

# pi-ai 1.3.0 model catalog changes

English | [中文](guide.zh.md)

## Change

The pi-ai dependency changes from 1.1.0 to 1.3.0. These chat model IDs leave the catalog. Stored `modelOverrides` report missing-catalog diagnostics; new overrides are rejected. Explicit `models` entries lose their catalog defaults.

| Provider | Removed model IDs |
|---|---|
| `google-vertex` | `gemini-flash-latest`, `gemini-flash-lite-latest` |
| `nvidia` | `moonshotai/kimi-k3`, `nvidia/nemotron-3-super-120b-a12b` |
| `opencode` | `exo-free`, `fledge-alpha-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free` |
| `opencode-go` | `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `grok-4.6`, `minimax-m2.7` |
| `openrouter` | `anthropic/claude-sonnet-4`, `apodex/apodex-1.1-mini:free`, `inclusionai/ling-3.0-flash-fin`, `inclusionai/ling-3.0-flash-sante:free`, `qwen/qwen-plus-2025-07-28`, `qwen/qwen3-235b-a22b`, `qwen/qwen3-30b-a3b-thinking-2507`, `qwen/qwen3-8b`, `qwen/qwen3-coder-plus`, `qwen/qwen3-max`, `qwen/qwen3-max-thinking`, `qwen/qwen3-vl-235b-a22b-thinking`, `qwen/qwen3-vl-32b-instruct`, `qwen/qwen3-vl-8b-thinking`, `qwen/qwen3.6-max-preview`, `sao10k/l3.1-euryale-70b`, `unbiased/pareto`, `unbiased/pareto-26.10-preview` |
| `vercel-ai-gateway` | `alibaba/qwen-3.6-max-preview`, `alibaba/qwen3-235b-a22b-thinking`, `alibaba/qwen3-coder-plus`, `alibaba/qwen3-max`, `alibaba/qwen3-max-preview`, `alibaba/qwen3-vl-235b-a22b-instruct`, `alibaba/qwen3-vl-thinking`, `anthropic/claude-3-haiku`, `anthropic/claude-opus-4`, `inclusionai/ling-3.1-flash-free` |

These catalog limits decrease. Values are tokens; `—` means that limit did not decrease. Explicit overrides still take precedence. `maxTokens` describes model capacity, not an implicit request limit.

| Provider/model | New contextWindow / maxTokens |
|---|---|
| `anthropic/claude-sonnet-4-5` | 200000 / — |
| `anthropic/claude-sonnet-4-5-20250929` | 200000 / — |
| `openrouter/deepseek/deepseek-v4-flash` | 1048575 / 943717 |
| `openrouter/inclusionai/ling-3.0-flash-vl` | 131072 / — |
| `openrouter/meta-llama/llama-4-scout` | 131072 / — |
| `openrouter/minimax/minimax-m2` | — / 131072 |
| `openrouter/minimax/minimax-m2.5` | 198000 / 32768 |
| `openrouter/minimax/minimax-m2.7` | — / 131072 |
| `openrouter/moonshotai/kimi-k2-thinking` | — / 98304 |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b` | 202800 / — |
| `openrouter/openai/gpt-oss-120b` | — / 65536 |
| `openrouter/qwen/qwen3-235b-a22b-thinking-2507` | 128000 / 16384 |
| `openrouter/qwen/qwen3.5-35b-a3b` | 256000 / 16384 |
| `openrouter/qwen/qwen3.8-2.4t-a95b` | 1000000 / — |
| `openrouter/qwen/qwen3.8-27b` | 262144 / — |
| `openrouter/~z-ai/glm-latest` | — / 131072 |
| `radius/claude-sonnet-4-5` | 200000 / — |
| `vercel-ai-gateway/alibaba/qwen3-coder` | — / 32768 |
| `vercel-ai-gateway/deepseek/deepseek-v4.1-flash-fast` | — / 32768 |

The `vercel-ai-gateway` model `alibaba/qwen-3-235b` is now non-reasoning. Protocol and effort changes have a [separate guide](../pi-ai-protocol-replay/guide.md).

## Migration

1. In Settings → Models, replace removed IDs with supported models. Check endpoints, capabilities, and prices; IDs have no automatic replacement.
2. Update selections in `cordis.patch.yml`, preset patches, and affected Sessions. Remove obsolete `providers.<provider>.modelOverrides.<id>` entries and replace removed IDs in `providers.<provider>.models` lists. See the [configuration reference](../../../../packages/llm/llm-pi-ai/README.md).
3. Review capacity and reasoning overrides against the endpoint's supported values. Start the profile, confirm the model has no configuration diagnostic, and send a short prompt.
