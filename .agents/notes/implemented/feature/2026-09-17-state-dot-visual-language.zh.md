# Agent Note: StateDot 纯色标记与旋转 loading

Status: implemented

[English](2026-09-17-state-dot-visual-language.md) | 中文

## 问题

`StateDot` 混用了两套绘制语言：已结算状态在实心核外带半透明光晕，`ongoing` 则使用八格像素追逐动画。

## 决策

`idle`、`done`、`warning` 与 `error` 在既有 10px 布局槽内渲染一个 6px 纯色圆点，不再带光晕。`idle` 使用中性的 `--dsw-alias-state-idle-primary` token，`done` 保持成功绿色，`warning` 保持琥珀色，`error` 保持红色。

`ongoing` 是唯一不是圆点的成员。它的默认边长为 14px，纯色状态仍保留 10px 布局槽。它在透明度为 25% 的完整圆环上方，使用 tertiary label token 渲染灰色圆弧。图形以 1.5 秒周期持续旋转，圆弧围绕中心从 12 个 dash 单位增长到 24 个、再回到 12 个；圆弧偏移在首尾都为零，因此浏览器不会在循环边界重置第二段圆周运动。减少动态效果的环境保留中间长度的静态圆弧。显式 size 覆盖、`data-state` 与 `aria-hidden` 行为均不改变。

已转换的紧凑纯状态展示使用这套共享映射，不再自绘圆点或 spinner：等待或阻塞为 `warning`，活动工作为 `ongoing`，成功完成为 `done`，失败为 `error`，未活动或尚未开始为 `idle`。前置槽为业务图标的工具行在所有生命周期状态中都保留普通图标；收起摘要在失败时变红，在 `stopped` 时变为琥珀色并保留工具自有的中断文本。无框架的启动页保持独立，因为它会在 React 与共享原语可用前用圆弧表达 Loader 总体进度。

## 考虑过的替代方案

**保留像素追逐动画。** 否决，因为方块动画没有沿用已结算标记的圆形语言，看起来更像装饰性活动图形，而不是常规 loading 状态。

**填满完整 10px 槽位。** 否决，因为原来的可见实心核就是 6px；保留该直径只移除光晕，同时维持行密度。

## 测试

组件测试固定四种纯色状态元素、双圆环 loading 图稿、两条动画轨道、两条尺寸路径、无光晕样式和每个状态 token。Tool、Bash 与 Skill 行测试固定保留的业务图形，以及可见的红色失败摘要与琥珀色中断摘要。Workspace、Job、Workflow、Subagent、Deliverables、终端、插件、Schedule、Todo、Team、审批、文档预览、Trajectory 与连接测试固定各自的状态映射和无障碍 label。

## 后果

消费方保留无障碍 label，纯状态展示共享同一套视觉词汇。所有已结算标记在视觉上更安静、更紧凑，完成态保持绿色，所有活动态使用同一种 tertiary 灰色旋转 loading。重连等动作图标和文件或工具类型等业务图标在图形本身表达操作而不只表达状态时继续保留。
