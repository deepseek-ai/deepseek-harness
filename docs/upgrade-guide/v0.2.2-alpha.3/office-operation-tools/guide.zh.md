---
kind: upgrade-guide
description: "删除 `office-render`、`office-recalculate` 和 `office-export-pdf` 技能、skill-office 的 `node` 和 `cli` 配置键，以及两个 Office CLI 环境变量；Office 操作改用由技能激活的工具。"
---

# Office 操作技能由 Office 工具取代

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-skill-office` 不再注册 `office-render`、`office-recalculate` 和 `office-export-pdf` 技能，只注册 `office` 路由技能，以及 `office-docx`、`office-pptx` 和 `office-xlsx` 编写技能。加载 Office 技能后，模型从下一步起调用 [`office_render`、`office_convert` 和 `office_recalculate`](../../../../packages/document/tool-office/README.zh.md)。

配置变化：

| 已删除 | 替代 |
|---|---|
| `skill-office` 配置键 `node` 和 `cli` | 无；Office 工具在 Host 中转换 |
| `DSH_BUNDLED_OFFICE_CLI` 和 `DSH_BUNDLED_OFFICE_NODE` | 无；不再有组件读取它们 |
| `DSH_BUNDLED_PRIMARY_RUNTIME` | `DSH_PRIMARY_RUNTIME` |

`skill-office` 新增 `pythonEnvironment`。默认值 `'workspace-dependencies'` 让 Python 技能调用 `load_workspace_dependencies`；没有挂载 `@deepseek-ai/dsh-tool-workspace-dependencies` 的组合必须设为 `'user'`。`DSH_BUNDLED_OFFICE_SKILLS` 含义不变。

Office 工具在 Host 进程内用原生 LibreOffice Kit 引擎解析不可信的文档，不受 shell 沙箱和 PTC 权限约束，并具有 Host 用户的权限；输入仍由文件系统后端授权。`office-kit` 条目新增 `outputDirectory`（默认 `$DSH_HOME/office-kit/outputs`）、`outputRetentionMs` 和 `maxOutputStoreBytes`。

受影响的有：使用已删除技能的用户和提示词，设置了已删除配置键或环境变量的组合和启动器，`assetRoot` 技能副本，已保存的 `standard` 或 `ptc` 预设，以及依赖 shell 沙箱解析文档的部署。

## 迁移

1. 把每个已删除的技能替换为加载 `office` 并调用对应工具：
   - `office-render`：`office_render`；
   - `office-recalculate`：`office_recalculate`，`format` 为 `"xlsx"` 或 `"ods"`；
   - `office-export-pdf`：`office_convert`，`format` 为 `"pdf"`。
2. 从 `cordis.yml`、patch 和 overlay 的所有 `skill-office` 行中删除 `node` 和 `cli`。除非组合挂载了 `@deepseek-ai/dsh-tool-workspace-dependencies`，否则设置 `pythonEnvironment: user`。
3. 不使用随发行版 bundle、自行挂载 `@deepseek-ai/dsh-skill-office` 的组合，同时挂载 `@deepseek-ai/dsh-office-kit` 和 `@deepseek-ai/dsh-tool-office`。
4. 在启动器中不再设置 `DSH_BUNDLED_OFFICE_CLI` 和 `DSH_BUNDLED_OFFICE_NODE`，并把 `DSH_BUNDLED_PRIMARY_RUNTIME` 改名为 `DSH_PRIMARY_RUNTIME`。Python SDK 优先使用环境中设置或继承的 `DSH_PRIMARY_RUNTIME`（空值也一样），其次才是下载缓存；要使用缓存，请取消设置该变量。
5. 在 `assetRoot` 引用的副本中，用已安装包 `assets/` 下的对应目录替换其余四个目录，并删除三个已删除技能的目录。
6. 在 Agent 预设编辑器中保存过的 `standard` 或 `ptc` 预设会替换随发行版提供的插件列表，因此其 Session 没有 Office 工具。把下面这一行加入已保存的列表，或加入 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中 `preset-standard` 或 `preset-ptc` 行的 `config.plugins`（`<profile>`：`web` 或 `desktop`）：

   ```yaml
   - id: tool-office
     name: '@deepseek-ai/dsh-tool-office'
   ```

7. 需要在沙箱中解析文档的部署不挂载 `@deepseek-ai/dsh-tool-office`。
8. 确认：在 Desktop 的 `standard` 或 `ptc` 新 Session 中发送 `/office`，再另发一条导出 PDF 的请求；该请求会产生一次 `office_convert` 调用，返回临时 PDF 路径或 `unavailable` 消息。
