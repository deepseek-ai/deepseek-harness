# Agent Note: 含精简内联指导的单一 Office 技能

Status: implemented

[English](2026-11-06-single-office-skill.md) | 中文

## Problem

[Office 提供者](../../../../packages/skill/skill-office/README.zh.md)曾列出四个技能：`office` 路由，以及 `office-docx`、`office-pptx` 和 `office-xlsx` 三个创作技能。每次请求都携带四条目录摘要，而格式技能只有在路由选中之后才有用。每个格式技能都重复"加载 `office` 以获得 Office 工具"的指示，提供者把同一段 Python 环境说明追加到三个正文中，而且格式正文大多是限制模型做法的分步流程要求与示例，而非模型无法自行获知的非显而易见 harness 事实。若把这些格式正文拆成按需读取的独立文件，仍会多出一步 `read` 调用，并依赖 Host 文件系统访问。目录应只标识一次 Office 能力，并在一步之内仅加载 DSH 特有事实与静默数据丢失易错点。

## Decision

`@deepseek-ai/dsh-skill-office` 只注册 `office`。`office` 正文说明 `document_render`、`document_convert` 和 `document_recalculate` 会在下一步可用，指出内置 `pypdf` 用于读取现有 PDF、旧版 `.doc`／`.ppt`／`.xls` 需先用 `document_convert` 转换，内联列出 Word、PowerPoint 和 Excel 中会静默丢失格式、东亚字体、版面适配、公式计算值或工作表的精简易错点，并在末尾追加一次配置的 Python 环境说明。不再内置或读取单独的格式文件。本文取代[渐进式 Office 技能](2026-09-27-progressive-office-skills.zh.md)的目录与创作正文设计，同时保留[按需激活的 Office 工具](2026-10-31-native-office-tool.zh.md)的激活设计（`activationSkills` 默认为 `['office']`）。

[Office 工具](../../../../packages/document/tool-document/README.zh.md)的 `activationSkills` 默认为 `['office']`。目录发现和加载时，提供者读取 `office/SKILL.md`；文件缺失或元数据无效时，`office` 从目录中省略并记录警告，其他读取错误使本次发现不完整，由注册表重试。

由于全部指导都随 `skill` 工具结果返回，无需第二次 `read` 调用，且在本地、Desktop（`app.asar`）以及远程或 SSH 工作区中都能获得完全一致的指导。

## Alternatives considered

**保留四个目录技能。** 独立技能保留 `/office-docx`、`/office-pptx` 和 `/office-xlsx` 命令，用户也能定义同名技能替换单个格式。代价是每次请求多出三行目录，路由义务重复，Python 说明追加三次。

**把各格式指导放在按需读取的 `docx.md`、`pptx.md` 和 `xlsx.md` 中。** 资源文件能让单独的渲染或转换轮次不加载格式细节，但创作需要额外调用一次 `read` 工具，依赖 Session 的 `read` 工具能够访问 Host 文件（在 SSH 或远程文件系统中会失败），而且在只保留非显而易见易错点即可的情况下仍保留了冗长的流程规定。

**在目录中隐藏格式技能但仍可加载。** 这需要技能注册表提供一套独立于调用权限的通用目录可见性策略，只为一个提供者服务。

## Consequences

目录只携带一条 Office 摘要（约 ≤ 50 个估算 token），加载 `office` 只增加一段精简正文（含 Python 环境说明约 ≤ 350 个估算 token），并在下一步激活 Office 工具。所有 Office 任务都加载同一段精简正文，无需后续文件读取，技能指导也不依赖 Host 文件系统。

用户失去直接的格式命令和按格式覆盖：`/office` 是唯一的命令，用户定义的 `office` 技能会替换内置正文。迁移步骤见[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.5/office-single-skill/guide.zh.md)。

## Testing

`skill-office.spec.ts` 覆盖单一目录条目、描述与正文 token 预算、内联易错点与 Python 环境内容，`office/SKILL.md` 缺失、元数据无效或在发现后消失时的省略和警告，以及其他读取错误后的重试。`progressive-loading.spec.ts` 覆盖 native 和 PTC 模式下调用 `skill(office)` 并经过恢复和分叉。`activation.spec.ts` 覆盖 `['office']` 默认值。录制的 headless 场景 `office-progressive-native`、`office-progressive-ptc`、`office-skills`、`office-authoring-checker` 和 `office-skills-no-renderer` 回放单一技能流程。
