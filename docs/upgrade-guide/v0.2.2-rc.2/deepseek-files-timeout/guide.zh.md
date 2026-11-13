---
kind: upgrade-guide
description: "为上传较慢的 DeepSeek 网关保留较长的图片上传时限。"
---
# DeepSeek 图片上传时限

[English](guide.md) | 中文

## 变更

`filesApiTimeoutMs` 的默认值从 60,000 毫秒缩短到 20,000 毫秒。上传超时后，下一次需要上传图片的请求直接使用内联图片。连续超时会使跳过的请求次数翻倍，上传成功后清零。

## 迁移

如果网关需要原先的时限，在当前配置的 `cordis.patch.yml` 中为 DeepSeek 提供方设置 `filesApiTimeoutMs: 60000`。已显式设置的值继续生效。运行 `dsh --profile <profile> --dump-config`，检查提供方条目中的值。
