---
kind: upgrade-guide
description: "fs-observation-policy 行随发行版禁用，write、edit 与 apply_patch 不再要求先读，dsh-base 与 Web standard preset 新增 apply_patch。"
---

# 文件系统修改默认不再要求先读

[English](guide.md) | 中文

## 变更

在 0.2.2-alpha.2 中，`dsh-base` 挂载了 `@deepseek-ai/dsh-fs-observation-policy`，因此所有随发行版交付的 profile 中，`write` 拒绝覆盖模型未读过的文件，`edit` 拒绝未读或被外部修改的文件，模型提示语也点名该策略。现在 `fs-observation-policy` 行以 `disabled: true` 交付：`write` 直接覆盖，`edit` 直接替换字面文本，新增的 `apply_patch` 只凭上下文匹配应用 hunk，三者均无条件执行。`write` 与 `edit` 的提示语仍要求先读，但不再引用该策略。Review 采集、沙箱围栏与 `fs/observed` 事件不变。

`dsh-base` 的 `tool-fs` 行（headless、SDK、ACP）与 Web 的 `standard` preset 现在列出 `apply_patch`（`applyPatch: true`）；Web 的 `ptc`、`cordis` preset 保持 `applyPatch: false`。

受影响范围：所有随发行版交付的 profile（`headless`、`web`、`sdk`、`sdk-minimal`、`acp`），按 id 覆盖 `fs-observation-policy` 或 `tool-fs` 行的 profile patch，以及包含 `FS_NOT_OBSERVED` 或 `FS_STALE_VERSION` 拒绝的录制期望。

## 迁移

1. 要保留先读后写行为，在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）中加入：

   ```yaml
   - id: fs-observation-policy
     disabled: false
   ```

   已带有该行且 `disabled: false` 的 profile patch 无需改动；为退出策略而写 `disabled: true` 的可以删掉该覆盖。
2. 要在没有 `apply_patch` 的情况下运行，为 `headless`、`sdk`、`acp` 在 profile 的 `cordis.patch.yml` 中加入 `- {id: tool-fs, config: {applyPatch: false}}`；对 Web `standard` preset，在 Agent presets 设置页编辑它，或在 `packages/bundle/web-app/presets/standard.patch.yml` 的 `tool-fs` 行上设置 `applyPatch: false`。
3. 用 `dsh --profile <profile> --dump-config` 确认：`fs-observation-policy` 行显示预期的 `disabled` 值，`tool-fs` 行显示预期的 `applyPatch` 值。在会话中，行禁用时对未读文件执行 `edit` 成功，启用时以 `FS_NOT_OBSERVED` 失败。
