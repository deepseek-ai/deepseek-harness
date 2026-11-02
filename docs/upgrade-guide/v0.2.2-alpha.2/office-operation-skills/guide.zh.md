---
kind: upgrade-guide
description: "内置的 `office-render`、`office-recalculate` 和 `office-export-pdf` 技能已移除；Office 操作直接调用 `office` 工具。"
---

# 移除 Office 操作技能

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-skill-office` 原先注册七个技能：`office` 路由，`office-docx`、`office-pptx` 和 `office-xlsx` 创作技能，以及 `office-render`、`office-recalculate` 和 `office-export-pdf` 操作技能。现在它只注册路由和三个创作技能。路由和创作技能把渲染、重算和 PDF 导出交给 [`office` 工具](../../../../packages/document/tool-office/README.zh.md)，无需另外加载技能。

技能目录和 `/` 菜单不再列出这三个操作技能；指名它们的 `skill` 调用，以及 `/office-render`、`/office-recalculate`、`/office-export-pdf` 调用都找不到技能。已录制的 Session 保留原有的技能调用和结果。

受影响的有：

- 从 `/` 菜单调用这三个技能的用户；
- 指示模型加载它们的提示词、技能和脚本；
- 期望七个技能目录的测试和工具；
- 把 `skill-office` 条目的 `assetRoot` 指向自有技能目录副本的部署。

## 迁移

1. 把每处对已移除技能的调用或加载，改为让模型以对应操作调用 `office` 工具：
   - `office-render`：`operation: "render"`；
   - `office-recalculate`：`operation: "recalculate"` 并带 `format: "xlsx"` 或 `"ods"`；
   - `office-export-pdf`：`operation: "convert"` 并带 `format: "pdf"`。
2. 把期望的技能列表更新为 `office`、`office-docx`、`office-pptx` 和 `office-xlsx`。
3. 在 `assetRoot` 引用的副本中，用已安装包 `assets/` 下的对应目录替换其余四个目录，并删除 `office-render/`、`office-recalculate/` 和 `office-export-pdf/`；提供方不再读取它们。
4. 新建一个 Session，确认 `/` 菜单列出四个 Office 技能，并确认渲染文档的请求会调用 `office` 工具，且除 `office` 或创作技能外不加载其他技能。
