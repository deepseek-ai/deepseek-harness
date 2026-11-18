---
kind: upgrade-guide
description: "pi-ai request images inherit catalog dimensions and byte budgets unless their route explicitly overrides them."
---
# pi-ai image resize defaults

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-llm-pi-ai` applies the selected model's `inputLimits.images.resize` width, height, and byte budgets to request images. Previously, request projection used only the total-pixel budget and a fixed 1 MiB raw encoded-byte target. Catalog byte budgets count base64 payload and are converted to raw bytes. Images already stored in a Session receive the new request projection without rewriting their attachments.

The route's `requestImageMaxBytes` remains a raw encoded-byte override. The new `requestImageMaxDimension` overrides both catalog dimensions. Models without resize metadata retain the existing defaults. Both request serialization and screenshot coordinate targets use these resolved limits.

The aggregate `maxRequestImageBytes` budget stays at 20 MiB. Larger encoded images can cause earlier history-image offloading and reduce prefix-cache reuse; see the [retained-image example](../../../../packages/llm/llm-pi-ai/README.md#model-experience). The per-image byte target can be lowered independently of the aggregate budget.

## Migration

1. Leave both overrides unset to follow the installed pi-ai catalog. Review long-image resolution and request sizes after upgrading pi-ai.
2. If a gateway needs different dimensions, set `requestImageMaxDimension` in its `providers.<route>` configuration. Set `requestImageMaxBytes: 1048576` to preserve the previous raw byte target. Choose values the gateway accepts; these overrides can raise or lower the catalog values.
3. Verify the model-facing image descriptor's request dimensions and, for screenshots, the coordinate target. Neither width nor height may exceed the configured dimension. The byte setting remains an encoding target; the smallest quality-ladder result can exceed it.
