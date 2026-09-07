# Agent Note: GUI Full access 风险确认

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-gui-full-access-confirmation.md) | 中文

## 问题

在 Web 客户端的权限选择器中切换到 `danger-full-access` 只需一次点击，且预设以 Title Case 机器名 `Danger Full Access` 展示。Full access 会减少确认步骤，允许 agent（智能体）执行敏感操作、修改文件或运行外部命令，误点即在毫无刻意确认环节的情况下启用了最危险的预设。

## 决策

**每个权限选择器都把 `danger-full-access` 关进共享的页面内 `RiskConfirmation` 对话框：启用按钮在用户勾选明确的风险确认复选框前保持禁用；预设以 locale 所有的产品标签展示；所有取消路径都不作任何提交。**

- `RiskConfirmation`（ui-primitives）是受控的 Modal 组合：标题、说明、确认复选框、取消，以及 `acknowledged` 勾选前禁用的确认按钮。它始终是页面内对话框——Modal portal 到本文档 body，绝不打开可能落在另一块显示器上的原生或独立浏览器窗口。`Modal` 新增 `contentClassName` slot，令警示正文在受限的移动端／横屏视口内滚动，动作行保持固定。
- composer chip（ui-conversation 的 `PermissionSelect`）在 `/permission` 提交前拦截 Full-access 选择：`confirmation`/`acknowledged` 组件状态打开对话框，确认后经与其他选择完全相同的注入 `command` 通道提交 `/permission danger-full-access`；取消、Escape、关闭与遮罩点击均保持当前预设不变并重置复选框。会话锁定时确认自行撤销（`locked`／值缺席 effect），切换任务时随 `key={sessionId}` 重挂载而重置。文案经标准 `conversation` locale slot 以 `access.confirm.*` 键供给。
- `/permission` popup（ui-permission 构建于 ui-commands 外壳之上）以数据而非第二套对话框实现完成把关：`SelectOption` 新增可选的 `confirmation` 载荷，popup 控制器拥有 `confirming`/`acknowledged` 状态迁移，`PopupSelectView` 在门控选项未决期间把选择卡换成同一个 `RiskConfirmation`。
- 「通用」设置中的「权限」行在把 Full access 持久化为后续会话的默认值前，也使用同一个受控 `RiskConfirmation`。警示会明确说明该设置只影响后续会话；取消、Escape、关闭与点击遮罩均不会改动已存默认值。
- 规范内置预设名通过每个选择器的 locale 词典呈现（英文为 `Full access`，中文为「完全权限」），显式 host 标签保持原样。命令与 Settings 写入在 wire 上保留机器名，每份警示正文都保持中英文 locale 感知。

## 考虑过的替代方案

**原生／操作系统或独立窗口确认。** 已拒：对话框必须留在当前 WebUI 窗口内；第二个窗口可能出现在另一块显示器上，使决策脱离其守护的页面状态。

**每个界面的安全文案共享一个 locale namespace。**不予采用：ui-permission bundle 与 ui-conversation 可独立加载，而 Settings 警示说明的是另一种只影响后续会话的生效周期。每个 bundle 各自拥有文案，ui-permission 也将 popup 与 Settings 词典分开，而非跨 bundle 边界 import。

**在 host／权限后端把关。** 设计上即出界：本变更只涉浏览器客户端确认流；后端权限语义、默认值与更安全预设的一键行为均不变。

## 后果

进入 Full access 的每条可见 GUI 路径现在都要求刻意且知情的确认，代价是真想启用该预设的用户多一步对话框。新的选择器通过各自拥有的状态机复用共享对话框，或在 popup 路径挂 `confirmation` 载荷。验收：`input-bar.spec.tsx` 中编辑器流的门控用例、`popup-view.spec.tsx` 与 `popup.spec.ts` 的 popup 门、`permission-row.spec.tsx` 的默认设置门控、`atoms.spec.tsx` 的 Modal/RiskConfirmation 约定，以及组装态 Web 回放。
