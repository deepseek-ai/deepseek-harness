---
description: "为 Web profile 添加实验性逐调用 Auto review，在工具以 Full access 执行前使用当前 agent 的模型审查。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

[English](README.md) | 中文

## 概述

为 Web profile 当前会话权限选择器添加 Auto review。每次原生或 PTC inner 工具调用前，当前 agent 的 provider 与模型会评估待执行动作；获准调用以 Full access 执行。dsh 安装随附此层但默认关闭；在 Web 侧栏插件页开启或显式安装之前，默认 Web 保持三种权限模式。Auto review 是实验功能：它可能误放行不安全动作、误拒绝有用操作，并消耗额外 token。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

从源码 checkout 通过既有 CLI 将包安装到 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

CLI 会在需要时初始化 profile，并将本包声明的 patch 追加到 base 与 Web 层之后。Reconciliation 将 patch 激活为 profile 层；没有 `dsh.bundle.patch` 的包只是已安装依赖。在 composer 或 `/permission` 选择器中选择带右上标 `EXP` 的 `Auto review`，并确认当前会话风险对话框。显式 `/permission auto` 命令直接切换。通用设置与未来会话默认值不提供 Auto。

通过同一 CLI 移除此层：

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

### 获得的能力

Auto 在每个受支持调用的 body 执行前审查一次，包括每个已开始的 PTC `tools.*` inner call。它按实际效果分类：普通项目内操作和精确清理本 Session 创建的对象属于 low，直接允许；不可逆删除既有对象、生产操作、外部写入和安全控制变更属于 medium，需要当前 human 或直接父级明确授权动作、目标与范围。跨信任边界泄露敏感信息属于 high，始终拒绝。效果不明确、授权冲突未解决、响应不合法和技术失败都按拒绝处理。

被拒绝的调用使用普通工具卡片。折叠行标识 Auto review；展开输出说明 body 未执行，并显示可选理由。[Web 权限包](../../client/ui-permission-presets/README.zh.md)拥有选择器交互，[工具 UI](../../client/ui-tool/README.zh.md)拥有理由展示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml)把本包自身插入为 `auto-review` 行。[`src/index.ts`](src/index.ts)要求 LLM、permission、Session 与 tools 服务，然后在同一个 effect 中安装 preset contribution 和置前的 pre-execute listener。[权限 owner](../../interaction/permission-presets/README.zh.md)提供当前身份和进程目录；Auto 共用 Full access 既有沙箱与审批值，不改变工具定义。

Reviewer 从当前 Session surface 与待执行调用重建五个分区：固定策略、仅 cwd 的环境、带来源的项目约束、过滤后带来源的历史，以及完整待审动作。原生 schema 来自最新 request header。PTC binding 冻结其 schema，经由调度器传入临时执行元数据；开始与结算事件都不序列化描述或参数 schema。主 agent 的 `system/message` 节点、assistant 正文与 reasoning、tool results 全部排除。[决策记录](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)拥有权威、生命周期与 child 继承的理由。

卸载时先关闭选择与 review admission，经由既有 preset writer 将存活 Auto Session 迁移到 Full access，再中止并等待在途 review 结清，最后撤回 listener 与 contribution。旋钮与持久终端在迁移中保持不变。持久 Auto Session 缺少完整 integration 时不能发布；安装后重新打开需要用户显式操作。重装只恢复选项，不把存活 Session 切回 Auto。

本包不发布 runtime invariant companion：同一个 effect 拥有选择准入、review 登记、取消与清理，不存在能与这些自有操作相互偏离的独立观察。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验包](../README.zh.md)——发布策略与依赖隔离。
- [Web bundle](../../bundle/web-app/README.zh.md)——此 patch 扩展的稳定 profile。
- [Auto review 决策](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)——固定风险策略、权威与生命周期。
- [Tools](../../core/tools/README.zh.md)——执行、取消与 PTC 结果传播。

-----

<a id="model-experience"></a>
## 模型体验

### 逐调用 reviewer

#### 模型看到什么

Reviewer 使用最新 `request/header.config` 的 provider 与模型，并沿用 shipped adapter 默认 reasoning。固定 `REVIEW_POLICY` 替代恰好一个动作的人工审批：allow 后立即以 Full access 执行。其余四个分区只包含上文列出的保留事实。响应为一个严格 JSON text 对象，包含 `risk` 与 `decision`；deny 可附字符串 `reason`。Reasoning blocks 可以位于这唯一 text block 之前。只有 `low + allow`、`medium + allow/deny` 和 `high + deny` 合法。

#### Token 影响

每个受支持调用额外产生一次模型请求，不缓存、重试、截断、压缩，也不设单独的小型输出预算。超窗请求按拒绝处理。

#### KV Cache 影响

固定 reviewer policy 可以共享前缀；保留历史与待审动作随调用变化。Auto 不向主 agent 增加专门 runtime context 或模式切换提示词。

### 工具拒绝

#### 模型看到什么

拒绝消息为 `Auto review rejected tool "<name>"; its body was not executed`。普通原生错误渲染在前面加 `Error: `。PTC 使用既有 inner-call 异常与 catch 行为；被捕获的拒绝不强制外层 `run_code` 失败。可选原始理由是面向用户的持久结构化错误详情，绝不进入主模型内容。风险、reviewer prompt、reasoning 与原始响应都不持久化。

#### Token 影响

被拒绝调用只向主对话贡献普通固定错误结果。

#### KV Cache 影响

拒绝追加普通工具结果，不改写更早的上下文，也不隐藏既有模型可见信息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Auto 需要开启此 Web 层；默认 Web、Headless、通用设置与新会话默认值都不包含它。
- Auto 不提供文件沙箱。外层 `run_code` transport 及PTC 程序内直接 Node 效果不经过 inner-tool review。
- 模型分类可能出错。不提供确定性工具豁免、持久 grant、人工 fallback、可配置策略或重试层。
- 进程内 Auto child 独立审查自身调用。进程外 child 在父委派调用获准后保留原生权限系统。
- reviewer 在带行级豁免的情况下，通过已废弃的同步 `snapshotEvents()` 读取 Session 动作历史。此前的调用、PTC start 与直接父级的初始 prompt 目前都没有投影或分页读取方，因此迁移按[同步读取决策](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)继续延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
