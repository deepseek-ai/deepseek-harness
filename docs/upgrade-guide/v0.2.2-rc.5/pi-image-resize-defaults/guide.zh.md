---
kind: upgrade-guide
description: "请求图片在编码后执行字节硬上限，DeepSeek 的软目标改用 imageTargetBytes。"
---
# 请求图片的字节限制

[English](guide.md) | 中文

## 变更

模型请求图片区分编码字节硬上限 `maxImageBytes` 和软目标 `imageTargetBytes`。编码器保留 85/75/60 质量阶梯，只有最小结果仍超过硬上限时才继续缩小尺寸。每次缩放都从已保存的源图开始。连 1×1 图片也无法满足上限时，以 `IMAGE_REQUEST_TOO_LARGE` 失败，不返回超限字节。存储附件保持不变，请求缓存使用新的变换版本重新生成。

pi 只暴露硬上限。继续使用 `requestImageMaxBytes`，它现在限制编码后每张图的字节数。`requestImageBudgetCount` 默认为 20。最终硬上限取该单图上限与 `3 × floor(maxRequestImageBytes / (4 × requestImageBudgetCount))` 的较小值，内部软目标等于硬上限。默认每张图分得 0.75 MiB。宽高跟随目录限制，或由 `requestImageMaxDimension` 用同一个值覆盖；不支持分别配置不同的本地宽高上限。

DeepSeek 将可配置软目标 `imageMaxBytes` 重命名为 `imageTargetBytes`，默认仍为 2 MiB，硬上限固定为 32 MiB。CUA 的固定截图配置 `screenshotTarget.maxBytes` 也改为硬上限。请求图片目标描述最大尺寸，实际输出可能更小。请求总量限制仍按实际编码载荷执行。

## 迁移

1. 如果 pi 提供方配置已设置 `requestImageMaxBytes`，请检查现有取值。调低编码质量后仍超过该值的图片会继续缩小尺寸。通过 `requestImageBudgetCount` 配置预算分摊张数，它独立于保留图片数量上限。base64 总预算须为每份预算至少提供 4 个字节。若希望每张分配 1 MiB，应使用足够的总预算及分摊张数，例如 32 MiB、20 份，再设置 `requestImageMaxBytes: 1048576`。
2. 在 DeepSeek 的 `models` 和 `modelOverrides` 中，将 `imageMaxBytes` 改为 `imageTargetBytes`，值不得超过 32 MiB。旧字段会被拒绝，并提示迁移方式。
3. `ImageRequestTarget` 调用方将 `maxBytes` 改为 `maxImageBytes`，并提供不大于硬上限的 `imageTargetBytes`。包括坐标换算在内的调用方，都从 `readImageRequest` 获取最终宽高。直接调用 `readRequestImageFile` 和 `requestImageVariantId` 时须传入已解析的缩放参数；DeepSeek 辅助函数调用方改用 `resolveRequestImageTargetBytes` 和 `DEFAULT_REQUEST_IMAGE_TARGET_BYTES`。
4. 附件本地存储可配置 `requestImageMinShrinkFactor`，默认 1.1，必须大于 1；以及 `requestImageByteHeadroom`，默认 0.95，范围为 `(0, 1]`。检查实际编码字节满足硬上限，坐标映射与返回尺寸一致。
