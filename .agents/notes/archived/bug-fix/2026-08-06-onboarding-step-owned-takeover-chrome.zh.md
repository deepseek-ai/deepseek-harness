# Agent Note: 首次使用引导的接管界面框架移入步骤自身

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-onboarding-step-owned-takeover-chrome.md) | 中文

## 问题

设置外壳在 `settings.onboarding` 有已注册且本地未完成的步骤时，就立即挂出首次使用引导的接管界面框架——portal 到 body 的浮层，带不透明的 `--dsw-alias-bg-layer-1` 展示层、模糊遮罩，并把 `#root` 置为 `inert`。而每个步骤都要先加载私有事实才能判定自己是否需要出场（WelcomeNotice：经其设置 join 读取确认位；DeepSeekOnboardingDialog：经 Models join 读取凭据就绪状态），判定期间渲染 `null`。渲染 `null` 无法抑制界面框架，因为不透明展示层是外壳画在 slot outlet 外面的，不属于步骤。

于是每次在 hero（空白或无会话）状态下刷新页面，会话列表一变 `ready` 就弹出整屏不透明层——亮色主题下是白色——并阻断全部交互，时长恰好等于一次凭据/设置 RPC 往返；之后已配置好的步骤自我完成，图层消失。用户看到的就是每次刷新在 workspace/会话列表落地的瞬间闪一下白屏。

## 决定

接管界面框架属于步骤，不属于外壳。新增零 cordis 原语 `OnboardingSurface`（ui-primitives）：渲染 portal 到 body 的浮层／遮罩／展示层——CSS 类名与几何从 `SettingsRoot.module.css` 逐字迁移——并在自身挂载生命周期内保持 `#root` 为 `inert`。两个步骤组件只把各自的**可见**分支包进该原语；既有的 `null` 分支由此在构造上不绘制、不阻塞任何内容，因为界面框架已是同一次渲染决策的一部分。

`SettingsRoot` 的协调器原样保留（有序账本投影、每次挂载一个步骤、本地完成集合、`stepId`／`complete`／`openSection` currency），但对当选步骤裸渲染——不再有 portal、展示层和 inert 效果。`settings.onboarding` 的 slot 约定现在写明：注册方持有外层包裹，且在私有事实未决时必须渲染 `null`。

## 曾考虑的替代方案

**条件注册（账本即有内容信号）。** 私有 join 解析出「需要介入」后才注册条目。架构上干净（在 commit point 发布），但改动更大：join 的加载必须从对话框上移到各插件的 apply，注册／销毁在两个包里都变成响应式接线。对本缺陷而言过重，否决。

**把 `settings.onboarding` 改成 chain 并把完成集合外置为 store。** composer takeover 的版型；做过原型后回退。selector 只能判定 owner props，私有就绪事实仍然只能在组件内部解析——chain 买来的是当前两个步骤并不需要的路由通用性，代价却是跨三个包的约定变更。

**在渲染点探测 slot 输出为空。** `renderSlot` 无条件返回 outlet 元素，owner 无法根据步骤的 `null` 进行分支判断；探测已渲染 DOM 是否为空需要先提交再撤回的手法，其动态翻转会失去 paint 前的保证。

## 后果

步骤已挂载但尚未判定期间，应用保持可见且可交互：判定窗口内 `#root` 不再是 `inert`（此前在不透明图层背后处于 inert 状态）。对真正未配置的用户，接管层比从前晚一个 join 往返出现——但一出现就带着内容，而不是先露出空白展示层再填充。

未来若有步骤注册后不把可见内容包进 `OnboardingSurface`，会无遮罩地裸渲染在应用之上；slot 约定的 JSDoc 已把包裹写为注册方的义务。

## 测试

`packages/client/ui-primitives/tests/onboarding-surface.client.spec.tsx` 钉住原语行为：包裹内容的 body portal、遮罩／展示层类名存在、`#root` 的 `inert` 恰好持续挂载生命周期，以及无 `#root` 的组合。`packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` 钉住反转后的外壳约定：已挂载步骤什么都不渲染时，无接管界面框架、无 inert。`apps/web/tests/onboarding-deepseek-config.e2e.ts` 新增本缺陷的整装回归钉：已配置世界刷新页面，同时在浏览器网络边界扣住所有 `settings.describe` 响应——把步骤的判定窗口从 loopback 下不可见拉宽到数百毫秒，这正是断言保持非空洞的关键——页内 8ms 采样器证明接管界面框架从未挂载、`#root` 从未变为 inert。该文件的既有场景与步骤 spec（`ui-settings-general`、`ui-settings-models`）原样通过——样式表逐字迁移，遮罩选择器与几何钉子得以幸存。
