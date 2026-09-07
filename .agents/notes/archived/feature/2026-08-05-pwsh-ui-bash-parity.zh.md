# Agent Note: pwsh UI presentation matches bash

Status: implemented
Archived: 2026-09-04

[English](2026-08-05-pwsh-ui-bash-parity.md) | 中文

## Problem

[pwsh 工具与 bash 对齐决策](../../implemented/feature/2026-08-02-pwsh-tool-bash-parity.zh.md) 让 `dsh-tool-pwsh` 在执行、marker 与后台任务上行为可互换，但明确推迟了面向人类的一半：完成的 pwsh 前台调用呈现为通用 `console` 围栏卡片，而 bash 工具的完成调用呈现为带解析退出状态 pill 的 terminal 卡。负责解决此缺口的路线图（[Windows 默认改用 pwsh](../../implemented/feature/2026-08-01-windows-pwsh-default.zh.md)）把「pwsh TUI/GUI 渲染」列为阶段 2，但 TUI 包已被移除，使 Web 表面成为该缺口唯一影响的 UI。

## Decision

`dsh-tool-pwsh` 的 `presentResult` 现在逐调用镜像 `dsh-tool-bash`：完成的前台结果是 `terminal` 卡，输出正文为去 marker 的渲染文本，退出状态 pill 为解析出的 `exitCode`/`signal`；后台 ack 与 `isError` 结果保持通用 `console` 围栏卡片；非单一文本块结果保持不变（`undefined`）。

解析是共享而非复制：`parseExitStatus`/`ParsedExitStatus` 从 `dsh-tool-bash` 的私有 render 模块迁入 `@deepseek-ai/dsh-shell` Service Definition 包（由其 index 导出），`dsh-tool-bash` 的 `render.ts` 再导出它，使源平面消费方保持单一导入根。两个工具的渲染器发出相同的 `[exit code: N]` / `[killed by signal: X]` marker，因此一个由 Service Definition 拥有的逆解析永远不会在孪生之间漂移——与 [shell-env 抽取](../../implemented/feature/2026-08-02-pwsh-tool-bash-parity.zh.md) 处理 `DSH_*` 注册表时相同的「共享而非复制」形态。

Web UI 的卡片本身不需要任何按工具编写的代码：客户端的 terminal 卡桥接（`dsh-client-ui-conversation` 的 `terminal-card-model`）映射任意 `card: 'terminal'` 结果视图，因此 pwsh presenter 变更直接流经 bash 已有的同一渲染路径。折叠的工具行有一处客户端分类条目：`classifyTool('pwsh')` 现在归入 shell 家族行（`bash` variant，自有 `Pwsh` 标题），而非通用的 `others`「Tool call」行。一条 keyless 浏览器通道（`apps/web/tests/pwsh-terminal.e2e.ts`）预置一个会话，其 pwsh 调用/结果在回放时由真实工具呈现（api-proxy 从已记录的 args/result 内容重新计算视图），并钉住 terminal 卡 golden，包括退出 pill 与运行状态点。

## Alternatives considered

**从 `@deepseek-ai/dsh-tool-bash/src/render.ts` 导入 `parseExitStatus`。** 否决：workspace 导入在构建产物中保持外部引用，因此 `tool-pwsh` 会在每个消费方闭包中新增对 `tool-bash` 的硬运行时依赖（包括刻意只挂 pwsh 孪生、不挂 bash 的组合），且兄弟工具为一个函数而依赖其孪生会颠倒包间关系。seam 迁移把共享约定放在两个工具本就依赖的包上。

**新建专用呈现包（如 `@deepseek-ai/dsh-shell-present`）。** 否决：为一个纯函数新建包要付出 manifest（元数据清单）、module-graph/目录再生成与 README 内容的成本；`@deepseek-ai/dsh-shell` 已在两个工具的闭包中，且已拥有该解析重建的 `ShellRunResult` 事实。

**把解析复制进 `tool-pwsh` 的 render 模块（第三个孪生）。** 否决：复制的文本约定缺少共享实现就会漂移（[pwsh 工具与 bash 对齐](2026-08-02-pwsh-tool-bash-parity.zh.md)）；解析与 marker 发出必须在同一处共同演化，而解析恰恰是 UI pill 依赖的约定。

## Consequences

- 使用 `dsh-tool-pwsh` 的 Windows 组合现在在 Web UI 中显示的 shell 调用与 bash 调用完全一致：cwd 头的 terminal 卡、原始输出、退出状态 pill、运行状态点，以及非零退出时的红色失败处理。
- `parseExitStatus` 成为 `@deepseek-ai/dsh-shell` 公开约定的一部分；`dsh-tool-bash/src/render.ts` 继续再导出它，bash 工具消费方零改动。
- 路线图阶段 2 收窄：TUI 已移除（EOL），对应的 terminal 卡现已在 Web 表面交付。Windows 默认组合（阶段 1）仍是未完成的阶段。
- 验证：`dsh-shell` 在逐文件覆盖率门禁下拥有解析边界用例；`tool-pwsh` 的 presenter 套件镜像 `tool-bash` 的（干净/非零/信号/超时往返、形似 marker 的输出、后台/错误通用卡片、多块回退）；客户端行模型套件钉住 `Pwsh` shell 家族行；web `pwsh-terminal` 通道是组装后的 keyless 场景。
