# Agent Note: 单个 Office 技能，格式文件按需读取

Status: implemented

[English](2026-11-06-single-office-skill.md) | 中文

## Problem

[Office 提供者](../../../../packages/skill/skill-office/README.zh.md)曾列出四个技能：`office` 路由，以及 `office-docx`、`office-pptx` 和 `office-xlsx` 三个创作技能。每次请求都携带四条目录摘要，而格式技能只有在路由选中之后才有用。每个格式技能都重复"加载 `office` 以获得 Office 工具"的指示，提供者还把同一段 Python 环境说明追加到三个正文中。目录应只标识一次 Office 能力，把格式细节留给需要它的任务。

## Decision

`@deepseek-ai/dsh-skill-office` 只注册 `office`。Word、PowerPoint 和 Excel 指导位于 `office` 技能目录下的 `docx.md`、`pptx.md` 和 `xlsx.md`。`office` 正文只往下一层引用这些文件，模型用 `read` 只读取任务涉及的格式，并按技能结果给出的基础目录解析相对路径。单独的渲染、转换或重算不读取格式文件。提供者只在 `office` 正文末尾追加一次配置的 Python 环境说明，格式文件引用这段说明。本文部分取代[渐进式 Office 技能](2026-09-27-progressive-office-skills.zh.md)：其精简路由保留为 `office`，格式文件取代其三个各格式技能；[按需激活的 Office 工具](2026-10-31-native-office-tool.zh.md)保留其激活设计，只改用新的默认值。

这与 Anthropic 为 Agent Skills 描述的三级渐进式加载一致：目录元数据随每次请求出现，任务匹配时加载技能正文，某一步需要时再读取引用文件。

[Office 工具](../../../../packages/document/tool-office/README.zh.md)的 `activationSkills` 默认为 `['office']`。读取格式文件不会激活任何工具；由于模型只能经由 `office` 正文找到格式文件，需要格式指导时工具已经激活。目录发现和加载时，提供者要求三个格式文件都是普通文件；文件缺失或不是普通文件时，`office` 从目录中省略，并记录给出该路径的警告。

格式文件是 Host 上的文件。Desktop 中它们位于 `resources/app.asar` 内，`read` 工具借助 Electron 的归档支持读取。使用 SSH 或其他无法访问 Host 文件的文件系统后端时，`read` 打不开这些文件，模型只能得到 `office` 正文中的指导。

## Alternatives considered

**保留四个目录技能。** 独立技能保留 `/office-docx`、`/office-pptx` 和 `/office-xlsx` 命令，用户也能定义同名技能替换单个格式。代价是每次请求多出三行目录，路由义务重复，Python 说明追加三次。

**在目录中隐藏格式技能但仍可加载。** 这需要技能注册表提供一套独立于调用权限的通用目录可见性策略，只为一个提供者服务。资源文件则利用现有技能结果中的基础目录和 `read`，无需修改注册表或 `skill` 工具。

**把所有格式内联到 `office` 正文。** 单一正文省去额外的读取，但每个 Office 任务（包括单独的渲染）都会加载三种格式的指导。

## Consequences

目录只携带一条 Office 摘要。创作需要多一步模型调用来读取格式文件，该 `read` 结果与技能结果一样保留在历史中。`office` 正文加一个格式文件的预算不超过原先"路由加格式技能"的预算；`read` 的行号前缀是额外开销。

用户失去直接的格式命令和按格式覆盖：`/office` 是唯一的命令，用户定义的 `office` 技能会连同格式文件路由一起替换内置正文。迁移步骤见[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.4/office-single-skill/guide.zh.md)。组合中必须提供文件 `read` 工具；在 SSH 工作区中进行 Office 创作时，除非格式文件能通过 Session 的文件系统访问，否则得不到格式指导。

## Testing

`skill-office.spec.ts` 覆盖单一目录条目、描述与正文预算、`SKILL.md` 的一层引用、各格式文件相对 `read` 工具默认值的行长和字节上限，以及格式文件缺失、是目录或在发现后消失时的省略和警告。`progressive-loading.spec.ts` 覆盖 native 和 PTC 模式下先 `skill(office)` 再 `read` 格式文件，并经过恢复和分叉。`activation.spec.ts` 覆盖 `['office']` 默认值。录制的 headless 场景 `office-progressive-native`、`office-progressive-ptc`、`office-skills`、`office-authoring-checker` 和 `office-skills-no-renderer` 回放读取路径；构建后的 Desktop Host 资源测试从公布的资源目录读取 `docx.md`。
