# Agent Note: Models 页扩展插槽

Status: implemented
Archived: 2026-09-04

[English](2026-08-26-models-page-extension-slots.md) | 中文

## Problem

出于提供方服务条款的考虑，pi-ai catalog 的提供方登录（GitHub Copilot、OpenAI 账号）正从产品中移出，改由一个可选的仓库外插件承担。该插件需要把登录按钮与登录过程 UI 放进 Models 页的提供方卡片——用户与提供方相遇的界面——但 `ui-settings-models` 的卡片由封闭代码渲染：唯一的集成途径是修改本包，外部插件做不到；页面仅有的开放缝隙（`settings.section`）只能新增一整个独立页面。

## Decision

`ui-settings-models` 在 `src/client/slot-contract.ts` 声明两个 SlotMap 席位，在其 `settings.section` 注册中以 `children` 认领它们，并从 `./client` 再导出其类型，使仓库外插件通过 type-only import 即可获得类型合并。

`settings.models.provider-card` 为 `keyed`，`entryKey = ConfigurableProviderView.settingsNs`：以某适配器家族的 settings namespace 注册一次，即可收到该家族的全部卡片——内置 catalog 路由、从目录采纳的行、手工声明的路由一视同仁——而分区从不解释这个 key。键域保持开放字符串空间（不设 `keyProps` 表），因为手工声明的路由 id 由用户在运行时命名。该席位在每张展示目录行的卡片上分发：已保存行的卡片、其首次运行 setup 形态、以及「添加提供方」草稿卡（其休眠行，实际为 `configured: false`）——草稿卡正是登录价值最大的时刻：用户刚遇到该提供方、手中还没有密钥。手工声明的草稿卡在保存前没有目录行，不分发。Owner props 携带该行的 `ConfigurableProviderView`、其 `configured` 合并结果与已确认的 api-key 凭据状态（`keyConfigured`，首个消费者用它在已存密钥旁抑制登录入口）；更多字段没有现役消费者。

`settings.models.footer` 为 `list` 席位，位于行列表与新增控件之后，承载孤儿记录管理这类分区级扩展内容。

没有注册方时两个席位均不渲染，产品页面与之前逐像素一致。

## Alternatives considered

**用 `list` 席位、由注册方自行筛选，替代按键分发。**每个注册方都会在每张卡片上渲染（再返回 null），且两个插件可能在同一家族的卡片里静默交错 UI。按 namespace 分发让每个适配器家族有唯一可问责的扩展所有者、零浪费分发，并完全复用 `settings.plugin.item` 的配对理由。

**按提供方路由 id 分发。**路由 id 是动态的——手工声明的路由由用户在运行时命名——插件无法先于目标行注册，还得随目录变化反复重注册。

**用 `chain` 席位整体接管卡片。**没有现役消费者需要替换编辑器；登录界面是加法。接管契约还会让分区布局成为兼容面。将来仍可在不动这两个席位的前提下追加 chain。

**把登录 UI 继续织在 `ui-settings-models` 里（插件化之前的设计）。**会把服务条款敏感的界面随产品发布，而这正是本扩展点要避免的结果。

## Consequences

仓库外插件现在无需改动产品即可把按家族的卡片 UI 集成进 Models 页；`llm-pi-ai-oauth` 是首个消费者。代价是一份公开契约：`ProviderCardExtrasOwnerProps` 在 `./client` 边界暴露 `ConfigurableProviderView`，且各分发位点（已保存卡片、setup 形态、新增草稿、footer）成为扩展方依赖的行为。每个适配器家族的 keyed 单元格同一时刻只渲染一个所有者：同一 namespace 下同 priority 的第二次注册会被注册表拒绝，不同 priority 则是刻意的遮蔽（最低 priority 的条目渲染）——这是 slot 套件的标准覆盖通道，绝非静默合并。
