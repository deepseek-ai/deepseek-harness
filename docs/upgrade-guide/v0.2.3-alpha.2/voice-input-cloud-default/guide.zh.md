---
kind: upgrade-guide
description: "语音输入 Bundle 的识别服务默认值由本地 SenseVoice 改为“自动”：有 DeepSeek 账号或 API Key 时使用 DeepSeek 云端识别。"
---
# 语音输入默认使用云端识别

[English](guide.md) | 中文

## 变更

实验性语音输入 Bundle 原先把 `speech-to-text.defaultProvider` 设为 `sensevoice-local`，录音在运行 DSH 的机器上识别。现在它设为 `defaultProvider: auto`，配合 `autoOrder: [deepseek-asr, sensevoice-local]`，并加入 DeepSeek 云端 Provider：已登录 DeepSeek 账号或配置了 DeepSeek API Key 时，录音发送到 DeepSeek 语音识别接口，并由该凭据付费；否则使用本地 SenseVoice Provider。受影响的是启用了 Bundle、未在其详情中选择识别服务、有 DeepSeek 凭据、并希望录音留在本机的用户。已在 Bundle 详情中选择的识别服务保持不变。

## 迁移

1. 如需继续使用本地识别，打开插件页，进入“语音输入”详情，在识别服务中选择“SenseVoiceSmall (INT8) 本地识别”。这会把 `defaultProvider: sensevoice-local` 写入 profile patch `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中的 `speech-to-text` 条目。
2. 确认方法：把鼠标悬停在输入框的麦克风上，提示为“听写”而不带“云端识别”，详情中显示当前使用本地识别器。
