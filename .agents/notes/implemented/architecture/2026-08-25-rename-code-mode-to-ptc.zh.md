# Agent Note: 将 code-mode 重命名为 ptc——传输层命名为 PTC，用户文案使用 PTC mode

Status: implemented

[English](2026-08-25-rename-code-mode-to-ptc.md) | 中文

## 问题

通过生成的 SDK 与 `run_code` 传输层向模型呈现工具的注册表模式，发布时用的名字是 Code Mode；而选择该模式的客户端预设早已以「PTC mode」发布（locale `presetPtcName: 'PTC mode'`，中文 `PTC 模式`）。同一功能有两套名字：配置值、插件与事件名、文件与文档写的是 `code`／`code-mode`，用户可见的名字却是「PTC mode」。预发布阶段的更名必须一次性更新所有引用——不加任何兼容别名。

## 决策

该功能更名为 PTC（programmatic tool calls，程序化工具调用）。代码标识符使用 `ptc`——该传输层并非 plan-mode 的同类模式，因此标识符不带 `-mode`。用户可见文案沿用「PTC mode」（英文）／「PTC 模式」（中文），与已发布的预设名一致。

本 PR 完成的重命名包括：

- 配置值 `tools.mode: 'code'` → `'ptc'`（`ToolPresentationMode` 以及 `dsh-tools`、`dsh-agent-tool-presentation` 中的 zod union）
- 预设目录 `presets/code/` → `presets/ptc/`（预设 id 为 `ptc`）
- 源文件与测试文件 `code-mode.ts` → `ptc.ts` 等；根 demo `demo:code-mode` → `demo:ptc`（`scripts/demo-ptc.mjs`）
- 分发 waterfall `tools/code-dispatch-log` → `tools/ptc-dispatch-log`，类型 `CodeDispatch*` → `PtcDispatch*`
- 提示词规则 `tools:code-only` → `tools:ptc-only`
- 文档、README 与八个以该功能命名的 implemented Agent Note 中的文案 "Code Mode" → "PTC mode"／"PTC 模式"（这些 Note 文件一并就地改名）

会话持久词汇继续延后处理：持久事件类型 `tool/code-dispatch`／`tool/code-dispatch-start`、日志中的插件名 `tools-code-mode`、子调用 id 段 `:code:`。重命名这些值属于结构性 Session 格式变更，必须在恒等 v0-to-v1 基础之后拥有自己的相邻迁移边。

保持不变：`run_code` 及其 `code` 参数（它们描述程序载荷，而非模式）、`CodeSdkLanguage`、`CodeRunFailedError`、`dsh-code-runtime*` 包族、第三方二进制名 `codex-code-mode-host`，以及所有冻结的 archived Note。

## 备选方案

- **使用 `ptc-mode` 标识符**——否决：PTC 是工具呈现传输层，不是 plan-mode 意义上的模式，标识符不应宣示这种亲缘关系。
- **仅重命名表面**——否决：预发布立场要求一次性更新所有引用。
- **连 `run_code` 一起改名**——否决：该工具名描述的是运行程序，不是模式，而且是对模型可见的 API 表面。
- **不提供相邻迁移边就重命名持久事件词汇**——否决：就地重命名 `tool/code-dispatch*` 会让更名前的 Session 日志无法读取；该重命名需要后续结构格式版本与显式迁移。

## 后果

配置中写 `mode: code`、预设 id 为 `code`，在本构建上不再受支持。会话持久词汇仍为 `tool/code-dispatch*`、`tools-code-mode` 与 `:code:`；恒等 v0-to-v1 迁移边会保留这些值，因此本次更名不包含结构版本变更。后续相邻迁移边必须重命名该词汇并刷新包含分发的 fixture（参见[版本机制](2026-08-10-session-log-version-mechanism.zh.md)）。本 Note 所更名的已发布决策是 [PTC 基础 Note](../feature/2026-06-15-ptc.zh.md)。
