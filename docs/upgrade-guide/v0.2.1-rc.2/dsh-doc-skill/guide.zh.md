---
kind: upgrade-guide
description: "创造模式用一个 `dsh-doc` skill 取代原有的四个 skill，仓库文档 skill 更名为 `dsh-doc-writing`。"
---

# `dsh-doc` 取代创造模式的 skill

[English](guide.md) | 中文

## 变更

创造模式原先从 `@deepseek-ai/dsh-agent-preset` 提供四个 skill（技能）：`cordis-plugin-development`、`editing-cordis-compositions`、`cordis-composition-reference` 和 `agent-experience`。现在只提供一个 skill：`dsh-doc`。原有内容位于该包 `skills/dsh-doc/references/` 和 `skills/dsh-doc/templates/` 下的文件中，由 `dsh-doc` 按需读取。旧 skill 名称不再出现在 skill 目录中，按名称加载旧 skill 会失败。

在 DSH 源码 checkout 中，文档编写 skill `.agents/skills/dsh-doc` 现为 `.agents/skills/dsh-doc-writing`，名称为 `dsh-doc-writing`。

受影响的对象包括：提示词、已保存指令或自有 skill 中引用旧 skill 名称的创造模式用户，以及读取旧路径文件的组合或脚本。

## 迁移

1. 将提示词、指令和 skill 中的每个旧 skill 名称替换为 `dsh-doc`；源码 checkout 中的文档 skill 改用 `dsh-doc-writing`。
2. 按下表替换 `@deepseek-ai/dsh-agent-preset/skills/` 下的文件路径：

   | 旧路径 | 新路径 |
   |---|---|
   | `cordis-plugin-development/SKILL.md` | `dsh-doc/references/plugin-development.md` |
   | `cordis-plugin-development/references/<file>` | `dsh-doc/references/<file>` |
   | `cordis-plugin-development/templates/<name>/` | `dsh-doc/templates/<name>/` |
   | `editing-cordis-compositions/SKILL.md` | `dsh-doc/references/compositions.md` |
   | `cordis-composition-reference/SKILL.md` | `dsh-doc/references/composition-reference.md` |
   | `cordis-composition-reference/references/packages.md` | `dsh-doc/references/packages.md` |
   | `agent-experience/SKILL.md` | `dsh-doc/references/tool-design.md` |

3. 将 `customSkillDirs` 设为该包 `skills` 目录的组合无需修改。
4. 重命名或删除项目 `.dsh/skills/` 或 `.agents/skills/` 中名为 `dsh-doc` 的 skill：项目 skill 优先级更高，会遮蔽随包提供的同名 skill。在 DSH 源码 checkout 中，将该 checkout 更新到包含本变更的修订版本；本变更会重命名仓库 skill。
5. 使用包含本变更的安装或修订版本新建一个创造模式会话，确认 skill 目录列出 `dsh-doc`，且不包含本包此前提供的四个 skill 中的任何一个。
