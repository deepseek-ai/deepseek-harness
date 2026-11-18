---
kind: upgrade-guide
description: "pi-ai 请求图片继承目录中的尺寸和字节预算，路由显式配置优先。"
---
# pi-ai 图片缩放默认值

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-llm-pi-ai` 将所选模型的 `inputLimits.images.resize` 宽度、高度和字节预算应用于请求图片。此前，请求投影只使用总像素预算和固定的 1 MiB 原始编码字节目标。目录字节预算按 base64 载荷计算，使用时换算为原始字节。Session 中已保存的图片也会使用新的请求投影，存储附件保持不变。

路由的 `requestImageMaxBytes` 仍用于覆盖原始编码字节目标。新增的 `requestImageMaxDimension` 同时覆盖目录中的宽度和高度限制。没有缩放元数据的模型保留现有默认值。请求序列化和截图坐标目标使用同一组解析后的限制。

## 迁移

1. 不配置这两个覆盖字段，即可跟随已安装的 pi-ai 目录。升级 pi-ai 后，检查长图分辨率和请求大小。
2. 网关需要不同尺寸时，在其 `providers.<route>` 配置中设置 `requestImageMaxDimension`。设置 `requestImageMaxBytes: 1048576` 可保留原来的原始字节目标。配置值须符合网关要求，这些覆盖值可以调高或调低目录值。
3. 检查模型侧图片描述中的请求尺寸；截图还需检查坐标目标。宽度和高度均不得超过配置的尺寸。字节配置仍是编码目标，质量阶梯中的最小结果可能超过它。
