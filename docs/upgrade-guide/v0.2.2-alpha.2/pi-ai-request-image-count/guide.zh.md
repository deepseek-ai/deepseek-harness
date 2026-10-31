---
kind: upgrade-guide
description: "当请求保留的图片超过 50 张时，pi-ai 路由现在会省略历史中最老的图片。"
---

# pi-ai 请求图片数量

[English](guide.md) | 中文

## 变更

`llm-pi-ai` 原先只用 `maxRequestImageBytes` 限制请求图片，因此在达到该字节上限前会重发每张保留图片。现在每条提供方路由还有 `maxRequestImages`（默认 50）和 `imageOffloadCountQuantum`（默认 10）。请求保留的图片多于 `maxRequestImages` 时，`dsh-compaction-image-offload` 把最老的 `imageOffloadCountQuantum` 张图片替换为占位文本并重试。该省略记录在 Session 中，不会回退。这会影响任何 pi-ai 路由上超过 50 张图片的 Session，包括单次请求接受更多图片的提供方。

## 迁移

1. 核对每个 pi-ai 提供方的单次请求图片上限。上限高于 50 时，在 `cordis.patch.yml` 的 `llm-pi-ai` 配置中把 `providers.<provider>.maxRequestImages` 设为该上限。
2. 如需改变每次超限省略的图片数，设置 `providers.<provider>.imageOffloadCountQuantum`；它不得超过 `maxRequestImages`。
3. 重新打开 profile 配置，确认保存的数值。参见[提供方配置参考](../../../../packages/llm/llm-pi-ai/README.zh.md)。
