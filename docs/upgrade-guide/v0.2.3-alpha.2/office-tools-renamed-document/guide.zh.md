---
kind: upgrade-guide
description: "dsh-tool-office 包及其 office_render、office_convert、office_recalculate 工具改名为 dsh-tool-document 和 document_render、document_convert、document_recalculate。"
---

# `dsh-tool-office` 改为 `dsh-tool-document`，工具改为 `document_*`

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，Office 工具来自 `@deepseek-ai/dsh-tool-office`，以 `tool-office` 行挂载，模型调用 `office_render`、`office_convert` 和 `office_recalculate`。现在包名为 [`@deepseek-ai/dsh-tool-document`](../../../../packages/document/tool-document/README.zh.md)，内置行的 id 为 `tool-document`，工具为 `document_render`、`document_convert` 和 `document_recalculate`。参数、结果、错误码和用于激活的 `office` 技能都不变。

受影响的有：引用 `@deepseek-ai/dsh-tool-office` 或给 `tool-office` 行打补丁的 `cordis.yml`、profile patch、overlay，以及已保存或自定义的 Agent 预设，它们将无法解析；按 `office_*` 工具名匹配的工具白名单、guard 或审批规则、hooks 和脚本，它们将不再匹配。升级前记录的 Session 仍可恢复：请求头中声明了 `office_*` 工具时，改名后的工具仍会激活，Web 对话记录也仍把之前的 `office_*` 调用显示为 Office 行。

## 迁移

1. 在每个 `cordis.yml`、`cordis.patch.yml`、overlay、`package.json` 和 import 中，把 `@deepseek-ai/dsh-tool-office` 换成 `@deepseek-ai/dsh-tool-document`，包括 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
2. 把以 `id: tool-office` 为目标的补丁行（例如 `- {id: tool-office, config: {activationSkills: [office]}}`）改为 `id: tool-document`。在 Agent 预设设置页编辑过的 Web 或 Desktop 预设，打开该预设并确认其 Office 工具行引用的是 `@deepseek-ai/dsh-tool-document`。
3. 在工具白名单、预设工具列表、guard 与审批规则、hooks 以及检查工具调用的脚本中，把 `office_render`、`office_convert`、`office_recalculate` 改为 `document_render`、`document_convert`、`document_recalculate`。
4. 用 `dsh --profile <profile> --dump-config` 确认出现 `tool-document` 行且没有行引用 `@deepseek-ai/dsh-tool-office`，然后在新 Session 中加载 `office` 技能，检查下一次请求声明了三个 `document_*` 工具。
