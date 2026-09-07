# Agent Note: DeepSeek Files 解析失败时恢复图片请求

Status: implemented
Archived: 2026-09-04

[English](2026-08-21-deepseek-files-inline-fallback.md) | 中文

## Problem

DeepSeek 官方视觉路由使用提供方文件 ID，使重复请求不必再次发送图片字节。如果 Files 端点不可用、不受支持或一直不返回，chat 会在模型请求开始前失败，即使同一端点仍接受内联图片数据。沿用 128MiB Files 预算的回退会超过内联请求体上限，独立转换图片的回退则可能发送与失败 file ID 尝试不同的像素。

## Decision

Files 仍是首选传输方式。每张请求图片的文件解析都有可配置的 `filesApiTimeoutMs` 时限，默认一分钟。stream idle 时限默认为五分钟，因此 Files 时限通常会为内联回退留出时间。部署也可以把 stream idle 时限设得更短，让它先终止请求。每次成功解析都会刷新外层 idle watchdog。调用方取消和外层流时限仍直接终止请求。

文件解析失败后，适配器会丢弃为该次 chat 尝试组装的临时文件块，并用 base64 data URL 重新组装完整图片请求。每张保留图片都复用已经准备好的确定性 `RequestImageAttachment`；回退不会再次解码、缩放或编码，同一个 chat 请求也不会混用 file ID 和内联图片。较早图片在后续图片失败前已经提交的上传映射会保留，供之后请求使用。下一次请求会重新尝试 Files，因此不需要保存进程级故障状态。

内联回退使用独立的 base64 膨胀后高水位，`maxInlineRequestImageBytes` 默认为 20MiB。`inlineImageOffloadByteQuantum` 默认为 10MiB，因此越过高水位时，确定性的最旧图片前缀会推进到下一个 10MiB 移除边界。现有 600 张图片上限和数量步长继续生效。文件模式继续使用 128MiB 高水位和 64MiB 移除步长。

提供方 chat 错误继续使用现有分类。失效 file ID 会被清除、重新上传并重试一次。如果替换解析失败，这次允许的重试会使用内联表示。普通 chat 错误不能证明 Files 解析失败，因此不会切换传输方式。

## Alternatives considered

**优先发送内联图片。** 不采用，因为 Files 上传成功后可以跨轮次复用确定性的请求字节，不必在每次请求中重复 base64。

**某次上传失败后混用已解析 file ID 和内联图片。** 不采用，因为请求仍依赖发生故障的 Files 服务，而且需要同时处理两套图片预算。

**把 128MiB Files 上限用于内联回退。** 不采用，因为 base64 会扩大负载，并可能超过 chat 请求体上限。20MiB 预算会为 JSON、文本历史和工具留下空间。

**记住故障，并在后续请求中跳过 Files。** 不采用，因为进程级状态会引入恢复时间和共享故障状态。下一次请求重新尝试 Files，可以在无需新增计时器的情况下发现服务恢复。

## Verification

序列化测试覆盖相同请求版本的文件和 data URL 表示、全部支持的媒体类型、工具结果位置，以及 20MiB 到 10MiB 的 base64 offload。适配器测试覆盖立即解析失败、部分 file ID 成功后的失败、时限触发的回退、失效 ID 替换失败、全内联请求体、调用方取消时不回退，以及普通 chat 错误不切换传输方式。配置测试覆盖两项内联预算，以及相互独立的 Files 和 stream idle 时限。

## Consequences

符合内联预算的图片 chat 不会再因 Files 故障而失败。回退会重复发送图片字节，而且由于上限更低，可能比文件模式省略更多历史。后续图片失败时，请求可能留下较早图片的成功上传，但这些索引映射可以复用，也不会改变回退发送的 chat 请求体。显式文件管理操作继续暴露自身错误。
