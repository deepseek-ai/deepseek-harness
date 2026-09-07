# Agent Note: Web skill 工具行

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-web-skill-tool-row.md) | 中文

## 问题

Web transcript（文本记录）通过通用后备行渲染 `skill` 调用，使已加载的指令集看起来像一次未知工具调用，尽管 Skill（技能）已是产品中的一等概念。通用行还会在结果旁暴露 JSON 参数的外层结构，围绕用户真正需要的唯一标识增加了噪声：已加载的 skill 名称。

## 决策

`ui-skill` 在 ui-tool 的 `tool.call.toolview` keyed slot 下注册 key 为 `skill` 的组件。该组件消费公开的 `ToolCallViewProps` owner 约定，并自行实现行 chrome，不导入 ui-tool 的展示内部实现。

收起的行使用 14 像素的文档与闪光组合图标，并沿用 Bash 行的中性色层级：图标采用三级色，`Skill` 标题采用二级色，分隔符采用 caption 色，skill 名称采用三级色。运行、失败和中断调用分别沿用 transcript 的扫光、错误状态点加首行摘要，以及警告状态点语义。已结算调用可以通过整个摘要行展开一个高度上限为 260 像素的 `Instructions` 卡片，其中原样呈现持久化结果文本；用于跳转至 trajectory 的现有 `Inspect` 入口仍保留在卡片下方。

该行的所有可见值均派生自当前 runtime 窗口中已配对的调用／结果片段。skill 名称来自已记录的 `name` 参数，指令来自持久化的结果内容；该行绝不关联当前 skill 目录来读取描述或提供方元数据。如果分页将调用留在窗口外，结果便没有工具身份，并继续使用通用后备路径，而不是扩展 history 协议约定。现有的 ACP（Agent Client Protocol）`skill-load` 记录经由真实的 Web 持久化与组合路径写入，用于无需密钥的交互和无障碍快照。快照只会在日历日期紧邻规范化时钟与 `Ran for` 页脚时移除该日期；时钟仍保留，使不同时区的宿主在同日边界产出相同快照。

## 考虑过的替代方案

- 保留通用工具行，只添加一个 `skill` 颜色选择器，并将其放在 `ui-conversation` 中。该方案仍会保留多余的输入外层结构和通用展开体，也会让 conversation 包拥有特定领域的视觉规则。
- 在宿主工具渲染意图联合类型中添加新的 `skill` 值。键控客户端 slot 在调用位于 runtime 窗口内时已经能够识别该工具，因此新的跨边界呈现值只会增加协议和快照表层，却不会支持其他消费方。
- 导出 conversation 包的私有 `ToolRow` 组件供复用。客户端包刻意对外暴露约定而非跨包组件；导出该组件会使独立功能包耦合到 conversation 的实现细节。

## 后果

除了引用 source 的依赖外，`ui-skill` 现在还依赖公开的 conversation toolview 约定、locale 包、原语包和 React。它自行保留了一小份折叠展开行 chrome，因此未来的全局交互变更必须与 Bash 示例和 conversation 行同步更新这个注册方。

即使已安装的 skill 目录发生变化，冷回放仍保持确定性；在用户显式展开指令前，transcript 保持紧凑。仅含结果的 history 页有意使用通用后备路径；让这个边缘情况保持通用呈现，可以保留现有 history 协议，并将该功能限定在客户端呈现层。专用卡片有意显示工具完整封装的输出，而不是只提取 `<skill_instructions>`，从而原样保留模型实际收到的内容，也避免为 skill 结果格式再引入一个解析器。
