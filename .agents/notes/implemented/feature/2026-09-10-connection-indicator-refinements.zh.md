# Agent Note: 连接指示器状态与交互细化

Status: implemented

[English](2026-09-10-connection-indicator-refinements.md) | 中文

## Problem

侧边栏连接药丸把操作提示藏在悬停切换里：断连与重试状态在悬停或聚焦时把文案替换为**立即重连**，因此每个状态都要为最宽的 label 预留空间以避免控件变形。一次不到一秒就恢复的重试会让连接中药丸闪现闪没，状态切换和消失也没有任何过渡、十分突兀。

## Decision

**断连药丸静态地展示其动作。** [ConnectionIndicator.tsx](../../../../packages/client/ui-primitives/src/ConnectionIndicator.tsx) 在断连文案旁常驻渲染重试图形（`IconRefreshOutline14`），文案为 `连接异常，刷新重试` / `Disconnected`（中文文案同时点明重试动作）；点击药丸仍会立即重连。悬停换文案和隐藏的最宽 label 占位 span 全部移除，药丸宽度随当前 label 自适应。连接中状态改用旋转圆弧 spinner 取代感叹号图形。出现与移除以 150ms 淡入淡出——可见状态之间的切换则原地替换内容：`EXIT_MS` 延迟卸载以匹配样式表的 `.leaving` 过渡，`prefers-reduced-motion` 会禁用全部动画与过渡。外观定为高 28px、水平内边距 8px、图标间距 4px、圆角 13px，以及 label 颜色 20% 透明度的 1px 边框。

**外壳拥有尝试节奏。** [SettingsRoot.tsx](../../../../packages/client/ui-settings-general/src/client/SettingsRoot.tsx) 让连接中药丸至少可见 `CONNECTING_MIN_VISIBLE_MS`（800ms），亚秒级重试不再闪动；无论手动还是自动，每次尝试都显示同一个文案`重新连接中`（`connection.connecting`）。2 秒恢复确认（`RECOVERY_CONFIRMATION_MS`）从恢复药丸实际可见时起算，驻留推迟其出现也不会缩短确认时长。两个时长是各自持有方的内置展示常量，不是配置。

## Alternatives considered

**给宽度变化加动画。** FLIP 式的像素测量过渡（记住旧宽度、钉住、过渡到新测量值）需要一个 layout effect 和命令式样式写入；纯淡入淡出已足够平静，无需这些。

**仅在悬停时切换为重试图形。** 常驻显示重试图形无需任何指针交互就说明了操作，与静态文案一致；悬停交叉渐变引入依赖交互的状态却不传达更多信息。

**进出场缩放。** 0.98 的缩放叠加在透明度淡入淡出上，在 12px 文字上读起来像抖动，因此只保留透明度。

**手动与自动尝试使用不同命名。** `ConnectionController.emitState` 会去重退避尝试之间重复的 `connecting` 状态，外壳观察不到尝试边界：外壳自持的手动重试标志要么在驻留中途翻转文案，要么在后续自动尝试中一直滞留。要正确区分文案需要连接层暴露尝试来源，而本次变更并不需要——两种尝试显示同一文案。

## Consequences

`ConnectionIndicator` 的 `reconnectLabel` prop 及其占位 span 从 pre-stable API 中移除；唯一消费者（`ui-settings-general`）在同一变更中更新。`settings-root.client.spec.tsx` 固定 800ms 驻留、驻留期间保持不变的单一尝试文案，以及按可见时刻起算的确认窗口；`atoms.client.spec.tsx` 固定退出时长后的卸载；`lifecycle-chrome.e2e.ts` 及其 ARIA golden 在真实浏览器中回放恢复流程。两个包的 README 重述了该交互。
