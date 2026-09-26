# Agent Note: 共享开发者工具设置

Status: implemented

[English](2026-09-17-developer-tools-settings.md) | 中文

## Problem

诊断视图、预设选择和改动文件摘要增加了日常任务的复杂度。支持脚本的 HTML 还授予了基础文档预览不需要的能力。桌面端和 Web 共享这些渲染器，分别设置开关会让同一设置在不同客户端产生不同结果。

## Decision

设置域内的 `ctx.configForms.developerTools` 偏好对象使用共享条目表单，提供一个已接受的 `ui-settings.enabled` 偏好。最初默认关闭的选择用于降低日常任务的复杂度；[偏好解析后默认开启开发者工具](2026-09-20-developer-tools-default-on.zh.md)取代该默认值并负责启动时的启用策略。Web 和桌面端的通用设置提供同一个开关。现有设置传输负责验证、有序写入、持久化和恢复；回环 Web 和桌面端跟随 Host 接受的状态。远程 Web 持有一个所有消费者共享的浏览器本地可观察值，刷新后重置，不发送 Host 写入。

关闭时隐藏 Trajectory View，在没有可见 View 声明工具调用检查能力时隐藏 Inspect 操作，可见 View 少于两个时隐藏会话 View 标签栏，隐藏新会话预设入口并拒绝 Agent 预设卡片的选择操作，并省略改动文件卡片及其摘要读取。其他插件注册的 View 保持可用。在 Trajectory 中关闭开关会激活 Chat。预设组合、保存的默认值、Session 事件和显式交付卡片保持不变。此偏好是展示策略，不是 Host 授权。

插件组装层将共享偏好转换为组件自身的能力（`showCodeDiff`、Agent 预设各界面读取的 `developerTools`，以及 `interactivePreview`）。Conversation 根据可见目标的 `toolCallFocus` 提供检查回调；Chat 不再指定目标名称。内置 HTML 渲染器使用 DOMPurify 清理完整文档并防护解析变异。关闭时保留根节点样式，移除主动文档、资源提示、SVG 动画及所有 `href` 属性，再放入不授予沙箱权限的 iframe，并通过 CSP 禁止脚本和外部资源。不读取关联文件。开启时保留不透明源的脚本 Blob 渲染器及其有界关联文件读取。切换模式会替换浏览上下文并清理待处理读取。[文档预览决策](../architecture/2026-09-08-document-preview-operations.zh.md)和[文件系统读取权限](../architecture/2026-09-09-workspace-file-read-authority.zh.md)继续定义高级渲染与 Host 读取访问。

## Alternatives considered

**仅在桌面端提供开关。** 所选需求没有仅限桌面的约束，相关 UI 也是共享的。桌面端条件判断会让 Web 渲染器的展示和预览行为不一致。

**隐藏控件但不改变激活的 View 或 iframe。** 之前选择的诊断内容和已经运行的脚本会在切换后继续存在。过滤可用 View 并重新挂载 HTML 上下文，可以立即执行所选展示策略。

## Consequences

基础 HTML 放弃 JavaScript、外部与关联资源和链接导航；行内样式与 data 图片仍可用。高级模式保留正常浏览器网络能力，不增加父源、弹窗、表单或顶层导航权限。此设置不约束第三方预览实现，也不撤销 Host 文件系统读取权限。

组件和设置测试覆盖默认值、schema 拒绝、已接受状态更新、入口折叠、改动文件展示和 iframe 清理。基于已记录 Session 的[文档预览](../../../../apps/web/tests/document-preview.e2e.ts)与[改动文件](../../../../apps/web/tests/changed-files-turn.e2e.ts)场景验证真实设置控件及共用渲染器。浏览器脚手架使用产品默认值，除非场景指定偏好。设置外壳、文档预览和改动文件场景显式关闭开发者工具；这些场景共同覆盖诊断控件隐藏、静态预览和切回 Chat。Host 拒绝写入后会恢复已接受状态，并显示本地化重试提示。原生 Electron 执行尚未验证。
