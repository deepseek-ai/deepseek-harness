---
kind: upgrade-guide
description: "pi-ai 1.3.0 目录移除了部分模型 ID，并降低了部分模型容量。"
---

# pi-ai 1.3.0 模型目录变更

[English](guide.md) | 中文

## 变更

pi-ai 依赖从 1.1.0 升级到 1.3.0。以下聊天模型 ID 不再包含在目录中。已保存的 `modelOverrides` 会报告目录条目缺失诊断；新的覆盖配置会被拒绝。显式 `models` 条目会失去目录默认值。

| 提供商 | 已移除的模型 ID |
|---|---|
| `google-vertex` | `gemini-flash-latest`, `gemini-flash-lite-latest` |
| `nvidia` | `moonshotai/kimi-k3`, `nvidia/nemotron-3-super-120b-a12b` |
| `opencode` | `exo-free`, `fledge-alpha-free`, `ling-3.0-flash-fin-free`, `ling-3.1-flash-free` |
| `opencode-go` | `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `grok-4.6`, `minimax-m2.7` |
| `openrouter` | `anthropic/claude-sonnet-4`, `apodex/apodex-1.1-mini:free`, `inclusionai/ling-3.0-flash-fin`, `inclusionai/ling-3.0-flash-sante:free`, `qwen/qwen-plus-2025-07-28`, `qwen/qwen3-235b-a22b`, `qwen/qwen3-30b-a3b-thinking-2507`, `qwen/qwen3-8b`, `qwen/qwen3-coder-plus`, `qwen/qwen3-max`, `qwen/qwen3-max-thinking`, `qwen/qwen3-vl-235b-a22b-thinking`, `qwen/qwen3-vl-32b-instruct`, `qwen/qwen3-vl-8b-thinking`, `qwen/qwen3.6-max-preview`, `sao10k/l3.1-euryale-70b`, `unbiased/pareto`, `unbiased/pareto-26.10-preview` |
| `vercel-ai-gateway` | `alibaba/qwen-3.6-max-preview`, `alibaba/qwen3-235b-a22b-thinking`, `alibaba/qwen3-coder-plus`, `alibaba/qwen3-max`, `alibaba/qwen3-max-preview`, `alibaba/qwen3-vl-235b-a22b-instruct`, `alibaba/qwen3-vl-thinking`, `anthropic/claude-3-haiku`, `anthropic/claude-opus-4`, `inclusionai/ling-3.1-flash-free` |

以下目录限制降低。数值以 token 为单位；`—` 表示该限制未降低。显式覆盖值仍然优先。`maxTokens` 描述模型容量，不是隐式的请求限制。

| 提供商/模型 | 新 contextWindow / maxTokens |
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

`vercel-ai-gateway` 的 `alibaba/qwen-3-235b` 模型现在被声明为非推理模型。协议与推理强度变更见[单独的指南](../pi-ai-protocol-replay/guide.zh.md)。

## 迁移

1. 在“设置 → 模型”中，将已移除的 ID 替换为受支持的模型。检查端点、能力和价格；ID 没有自动替代项。
2. 更新 `cordis.patch.yml`、preset patch 和受影响 Session 中的模型选择。移除过时的 `providers.<provider>.modelOverrides.<id>` 条目，并替换 `providers.<provider>.models` 列表中已移除的 ID。参见[配置参考](../../../../packages/llm/llm-pi-ai/README.zh.md)。
3. 根据端点支持的值检查容量与推理覆盖配置。启动 profile，确认模型没有配置诊断，再发送一个简短提示。
