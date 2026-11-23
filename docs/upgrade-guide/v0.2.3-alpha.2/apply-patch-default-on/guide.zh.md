---
kind: upgrade-guide
description: "dsh-base 的 tool-fs 行、PTC overlay 以及 Web 的 standard、ptc、cordis 预设启用 apply_patch，默认模型请求会带上它的 schema 或 run_code 绑定以及指引。"
---

# 所有内置组合启用 `apply_patch`

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，所有内置 `tool-fs` 行都设置 `applyPatch: false`，[PTC overlay](../../../../apps/cli/config/examples/ptc.yml) 也在 base 行上设为同样的值，默认组合不提供 `apply_patch`。现在 `dsh-base` 的 `tool-fs` 行（headless、SDK 和 ACP）以及 Web 和 Desktop 的 `standard`、`ptc`、`cordis` 预设设置 `applyPatch: true`，PTC overlay 不再覆盖 `tool-fs` 行：模型会在 `edit` 旁看到 `apply_patch` 及其指引，原生执行下是 JSON 工具，PTC 下是 `run_code` 绑定。

受影响的有：叠加或未叠加 PTC overlay 的 `headless`、`sdk`、`acp` profile，使用 `standard`、`ptc` 或 `cordis` 预设的 Web 和 Desktop 会话，以及记录默认工具集的录制预期。`sdk-minimal` 仍不启用文本工具。

## 迁移

1. 如需不使用 `apply_patch`，在 `headless`、`sdk`、`acp` 的 profile `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）中加入 `- {id: tool-fs, config: {applyPatch: false}}`；对 Web 或 Desktop 预设，在 Agent 预设设置页把它的 `tool-fs` 行设为 `applyPatch: false`。
2. 用 `dsh --profile <profile> --dump-config` 确认：`tool-fs` 行显示预期的 `applyPatch` 值。
