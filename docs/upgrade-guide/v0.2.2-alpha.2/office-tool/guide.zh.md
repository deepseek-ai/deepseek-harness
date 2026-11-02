---
kind: upgrade-guide
description: "Office 操作从经 shell 执行的 Kit CLI 路径改为在 Host 内运行的 office 工具；渲染不保存图片文件，skill-office 删除 node 和 cli 并新增 pythonEnvironment，Web 和 SDK 默认挂载 Office 技能。"
---

# Office 操作改用 `office` 工具

[English](guide.md) | 中文

## 变更

Office 渲染、转换和重算不再通过 shell 运行 LibreOffice Kit CLI。[`@deepseek-ai/dsh-tool-office`](../../../../packages/document/tool-office/README.zh.md) 包注册常驻的 `office` 工具。随发行版提供的 SDK profile，以及 Web 和 Desktop profile 的 `standard`、`ptc` 预设挂载该工具，因此其请求会声明它；`minimal` 不挂载。使用过 CLI 路径的配置和插件受到影响：

| 已删除 | 替代 |
|---|---|
| `skill-office` 配置键 `node` 和 `cli` | 无；Office 技能让模型调用 `office` 工具执行操作 |
| Office 技能中的 Node/CLI 路径 | `office` 工具；[已删除的操作技能](../office-operation-skills/guide.zh.md) |
| `DSH_BUNDLED_OFFICE_CLI` 和 `DSH_BUNDLED_OFFICE_NODE` | 无；不再有组件读取它们 |

`DSH_BUNDLED_OFFICE_SKILLS`、`DSH_PRIMARY_RUNTIME` 和 `DSH_BUNDLED_PRIMARY_RUNTIME` 含义不变。`office-kit` 行新增 `outputDirectory`、`outputRetentionMs` 和 `maxOutputStoreBytes`。

`render` 只返回供模型查看的页面图片，不保存 PNG 或其他图片文件。转换和重算的文件以 `$DSH_HOME/office-kit/outputs` 下的临时路径返回，由模型用 shell 复制。把页面导出为图片的请求会得到导出 PDF 的建议；需要文件时，以 `operation: "convert"` 和 `format: "pdf"` 调用 `office`。

该工具通过 `ctx.officeKit` 在 Host 进程内用原生 LibreOffice Kit 引擎执行由模型发起的 Office 操作，不受 shell 沙箱和 PTC 权限约束；输入仍受文件系统后端读取权限的约束。原生解析器以 Host 用户的权限处理不可信的文档，依赖 shell 沙箱约束文档解析的部署因此受到影响。

`skill-office` 新增 `pythonEnvironment`。默认值 `'workspace-dependencies'` 让 Python 技能调用 `load_workspace_dependencies`；没有挂载 `@deepseek-ai/dsh-tool-workspace-dependencies` 的组合必须设为 `'user'`。

Web 和 SDK profile 默认挂载 Office 技能，没有 primary runtime 时也挂载；新 Session 会在首条请求上下文和 `/` 菜单中列出它们。

## 迁移

1. 从 `cordis.yml`、patch 和 overlay 的所有 `skill-office` 行中删除 `node` 和 `cli`。
2. 不使用随发行版 bundle、自行挂载 `@deepseek-ai/dsh-skill-office` 的组合，同时挂载 `@deepseek-ai/dsh-office-kit` 和 `@deepseek-ai/dsh-tool-office`；除非挂载了 `@deepseek-ai/dsh-tool-workspace-dependencies`，否则设置 `pythonEnvironment: user`。
3. 不再在启动器中设置 `DSH_BUNDLED_OFFICE_CLI` 和 `DSH_BUNDLED_OFFICE_NODE`。
4. 把 Web 或 SDK Session 首条请求上下文和 `/` 菜单的预期结果更新为包含 Office 技能。
5. 在 Agent 预设编辑器中保存过的 `standard` 或 `ptc` 预设会按预设 id 替换随发行版提供的插件列表，因此其 Session 没有 `office` 工具。请在编辑器中把下面这一行加入已保存的列表，或加入 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中 `preset-standard` 或 `preset-ptc` 行的 `config.plugins`（`<profile>`：`web` 或 `desktop`），然后新建 Session：

   ```yaml
   - id: tool-office
     name: '@deepseek-ai/dsh-tool-office'
   ```

6. 确认：`standard` 或 `ptc` 的新 Session 声明了 `office`；以 `operation: "convert"` 和 `format: "pdf"` 调用 `office` 会返回临时 PDF 路径或 `unavailable` 消息。
