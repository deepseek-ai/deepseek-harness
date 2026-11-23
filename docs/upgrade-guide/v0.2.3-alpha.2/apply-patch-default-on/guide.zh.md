---
kind: upgrade-guide
description: "tool-fs.applyPatch 现在默认取 edit 的值，因此每个保留 edit 且未写 applyPatch 的 tool-fs 行都会提供 apply_patch。"
---

# `apply_patch` 默认跟随 `edit`

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，`tool-fs.applyPatch` 默认为 `false`，写了该键的内置 `tool-fs` 行都设置 `applyPatch: false`，[PTC overlay](../../../../apps/cli/config/examples/ptc.yml) 也设为同样的值，默认组合不提供 `apply_patch`。现在未设置的 `applyPatch` 取解析后的 `edit` 值，内置行也不再写 `applyPatch`：模型会在 `edit` 旁看到 `apply_patch` 及其指引，原生执行下是 JSON 工具，PTC 下是 `run_code` 绑定。

受影响的有：叠加或未叠加 PTC overlay 的 `headless`、`sdk`、`acp` profile，使用 `standard`、`ptc` 或 `cordis` 预设的 Web 和 Desktop 会话，任何挂载 `tool-fs`、开启 `edit` 且未写 `applyPatch` 的 profile patch、预设或插件，以及记录这些工具集的录制预期。Web 的 `minimal` 预设和 `sdk-minimal` 设置了 `edit: false`，仍不提供该工具。

## 迁移

1. 如需不使用 `apply_patch`，在 `tool-fs` 行上设置 `applyPatch: false`：`headless`、`sdk`、`acp` 在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）中加入 `- {id: tool-fs, config: {applyPatch: false}}`；Web 或 Desktop 预设在 Agent 预设设置页编辑它的 `tool-fs` 行；自定义预设或插件在其 `tool-fs` 声明中加入该键。
2. 关闭 `edit` 但需要 `apply_patch` 的行，设置 `applyPatch: true`。
3. 用 `dsh --profile <profile> --dump-config` 确认每个 `tool-fs` 行显示预期的 `edit` 值和你写出的 `applyPatch`；输出中不含推导出的值，因此再检查模型请求只在预期位置列出 `apply_patch`。
