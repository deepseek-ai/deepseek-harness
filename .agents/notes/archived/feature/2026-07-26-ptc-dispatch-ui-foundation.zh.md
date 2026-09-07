# Agent Note: PTC mode 的 UI 基础——run_code 的 description 参数，以及与原生同等保真的分发日志

Status: implemented
Archived: 2026-09-04

[English](2026-07-26-ptc-dispatch-ui-foundation.md) | 中文

> 范围：让 UI 能以与原生工具调用相同的保真度渲染 PTC mode 轮次的宿主侧约定变更，即其他 PTC mode UI Agent Note 赖以构建的基础。传输设计归 [PTC mode 基础](2026-06-15-ptc.zh.md)所有；模型可见的 `description` 参数、携带完整内容的 `tool/code-dispatch` 载荷，以及 `dsh` 配置树上临时的 `DSH_TOOLS_MODE` 启用开关，归本篇所有。

## 问题

`run_code` 轮次过去在每个产品界面上都不透明。调用卡片的标题就是原始程序文本，在行宽内无法阅读；而且不同于 `bash`（其必填的 `description` 用作卡片标签，命令本身放在展开后的输入里），`run_code` 完全没有模型撰写的标签。`tool/code-dispatch` 事件过去只携带每个子调用的 `resultSummary`（上限 200 字符、经 cwd 归一化），因此任何 UI 都无从展示子调用实际返回的内容：Web 对话视图（[chat 子调用行](2026-07-26-ptc-chat-subcall-rows.zh.md)）会用渲染原生 `tool/result` 卡片的同一批组件来渲染子调用，而有界摘要无法支撑一张与原生同等保真的卡片。同时，`dsh web` 组合此前根本无法启用 PTC mode：`tools` 行钉死在 schema 默认值上，配置树里也完全没有该运行时。

## 决策

三项变更，每项对应一个障碍：

1. **`run_code` 新增必填的 `description` 参数**（与 bash 完全相同的约定：主动语态、5-10 个词、展示在 UI 中；仅含空白的取值在执行时被拒绝）。`presentCall` 现在以该 description 作为卡片标题，并把程序文本移入 `rawInput`。提示词侧的成本是每次调用多出几个 token；换来的是每个界面——TUI 卡片、ACP（Agent Client Protocol）标题、Web 行——都无需解析 TypeScript 就能获得可供人阅读的标签。
2. **`tool/code-dispatch` 记录子调用面向模型的完整结果**（`content: ContentBlock[]` 加 `isError`，即 `tool/result` 的词汇），取代 `resultSummary`，并把摘要与 cwd 归一化机制彻底删除。UI 渲染子调用走的代码路径与渲染原生结果完全相同，包括错误文本和非文本块。该事件仍仅用于日志（`deriveMessages()` 忽略它）：模型上下文没有任何变化。
3. **`dsh` 配置树上的 `DSH_TOOLS_MODE` 环境变量**（`native`|`ptc`|`both`；未设置时保持 schema 默认值）：`tools` 行通过 `!!js` 读取它，worker 代码运行时则无条件挂载（本项交付时 loader 元数据仍是静态的，因此不存在条件行；后来的 [`disabled` 插值决策](../architecture/2026-08-11-loader-entry-disabled-interpolation.zh.md) 让条件行成为可能，但此处不变——native 启动只是注册该服务，worker 要到每次运行时才 spawn）。这是一个明确标注为临时的配置钩子：设计目标是让 Web UI 拥有按会话的工具模式选择，该目标落地后，这个环境变量随即退役。

## 曾考虑的替代方案

**保留有界摘要（提高上限，或上限加 `truncated` 标志）。** 否决：本堆叠 PR（Pull Request）链已敲定的要求是，子调用的行与详情必须与原生调用渲染得*完全一致*；任何上限都会强制引入第二条降级的渲染路径，外加截断 UI。转而接受的代价是：读取大文件的程序会把渲染后的内容原样记录在分发事件上，不设上限、位于 spill 策略之外，并以同样的字节数增大会话日志。持久化副本的 spill 集成已作为 [ptc-dispatch 日志 spill](2026-07-26-ptc-dispatch-log-spill.zh.md) 交付。

**一个 `--tools-mode` CLI（命令行界面）标志或 profile 配置键。** 推迟，而非否决：标志语法暗示永久性，profile JSON 又是用户配置；两者都会固化这个 seam，而按会话选择的设计本就打算移除它。环境变量则如实呈现了它权宜之计的本质。

**记录规范 `value`，而非渲染后的 `content`。** 否决：`tool/result` 持久化的是内容而非值（见[规范输出约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)），与原生同等保真意味着与之精确对齐；值始终仅存在于执行期本地。

## 后果

该 UI 变更本身不要求结构性 Session 格式递增。已发布 v0 边现在冻结可接受的历史分发 payload 并将其保留到 v1；畸形混合结构会在发布前被拒绝。既有的 PTC mode 快照 fixture（测试前置数据）已重新录制。模型可见范围扩大了：`run_code` 的 schema（新增一个必填参数）以及每一份 PTC mode 系统提示词／工具 schema 快照都发生了变化。Web UI 工作直接构建在新的事件载荷之上；每个子调用的实时运行状态已把本事件重塑为一对分发 start/end 事件（[实时并行分发](2026-07-26-ptc-live-parallel-dispatch.zh.md)）。
