---
kind: upgrade-guide
description: "Office 操作从经 shell 执行的 Kit CLI 路径改为 office 工具，删除 skill-office 的 node、cli 配置键和 Office 可执行文件变量，新增 pythonEnvironment，并在 Web 和 SDK 中默认挂载 Office 技能。"
---

# Office 操作改用 `office` 工具

[English](guide.md) | 中文

## 变更

Office 渲染、转换和重算不再通过 shell 运行 LibreOffice Kit CLI。新包 [`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.zh.md) 注册常驻的 `office` 工具，它通过 `ctx.officeKit` 在 Host 内运行 Kit。渲染的页面以图片形式出现在工具结果中；转换和重算的文件以 `$DSH_HOME/office-kit/outputs` 下的临时路径返回，由模型用 shell 复制。随发行版提供的 SDK profile，以及 Web 和 Desktop profile 的 `standard`、`ptc` Agent 预设挂载该工具，因此其请求现在会声明 `office` 工具；`minimal` 预设不挂载。配置或使用过 CLI 路径的组合、启动器和插件受到影响：

| 已删除 | 替代 |
|---|---|
| `skill-office` 配置键 `node` 和 `cli` | 无；操作技能调用 `office` 工具 |
| `office-render`、`office-export-pdf`、`office-recalculate` 中的 `## Installed LibreOffice Kit` 段落及 Node/CLI 路径 | `office` 工具 |
| `DSH_BUNDLED_OFFICE_CLI` 和 `DSH_BUNDLED_OFFICE_NODE` | 无；不再有组件读取它们 |

`DSH_BUNDLED_OFFICE_SKILLS`、`DSH_PRIMARY_RUNTIME` 和 `DSH_BUNDLED_PRIMARY_RUNTIME` 含义不变。`office-kit` 行新增 `outputDirectory`、`outputRetentionMs` 和 `maxOutputStoreBytes`。

`skill-office` 新增 `pythonEnvironment`。默认值 `'workspace-dependencies'` 让 Python 技能调用 `load_workspace_dependencies`；没有挂载 `@deepseek-ai/dsh-tool-workspace-dependencies` 的组合必须设为 `'user'`，让技能改用用户的 Python。

Web 和 SDK profile 现在默认挂载 Office 技能，没有 primary runtime 时也挂载。新 Session 的首条请求上下文会在技能目录中列出它们，`/` 菜单也会提供它们。

## 迁移

1. 从 `cordis.yml`、patch 和 overlay 的所有 `skill-office` 行中删除 `node` 和 `cli`；它们已不再生效。
2. 在不使用随发行版 bundle、自行挂载 `@deepseek-ai/dsh-skill-office` 的组合中，同时挂载 `@deepseek-ai/dsh-office-kit` 和 `@deepseek-ai/dsh-tool-office`，使操作技能可以运行；除非组合挂载了 `@deepseek-ai/dsh-tool-workspace-dependencies`，否则设置 `pythonEnvironment: user`。
3. 不再在启动器和 shell 包装脚本中设置 `DSH_BUNDLED_OFFICE_CLI` 和 `DSH_BUNDLED_OFFICE_NODE`。
4. 把 Web 或 SDK Session 首条请求上下文和 `/` 菜单的预期结果更新为包含 Office 技能。
5. 如果你在 Web 或 Desktop 应用的 Agent 预设编辑器中保存过 `standard` 或 `ptc` 预设，保存的插件列表会按预设 id 替换随发行版提供的列表，该预设中的 Session 不会获得 `office` 工具。请把下面这一行加入已保存预设的插件列表：可以使用 Agent 预设编辑器，也可以直接编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中 `preset-standard` 或 `preset-ptc` 行的 `config.plugins` 列表（`<profile>` 为 `web` 或 `desktop`），然后新建 Session：

   ```yaml
   - id: tool-office
     name: '@deepseek-ai/dsh-tool-office'
   ```

6. 加载 `office-export-pdf` 确认迁移完成：其正文提到 `office` 工具且不含可执行文件路径；以 `operation: "convert"` 和 `format: "pdf"` 调用 `office` 会返回临时 PDF 路径或 `unavailable` 消息。
