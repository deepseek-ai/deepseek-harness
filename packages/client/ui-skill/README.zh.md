---
description: "dsh Web 客户端的 skill 引用与专属 skill 工具行：/ 触发的 skill source 与 skill 调用卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill

[English](README.md) | 中文

## 概述

`dsh-client-ui-skill` 让用户通过在编辑器中键入 `/name` 来调用 skill：建议菜单从 `skills/list` Remote 提供用户可调用的 skill 候选，选择一项会落下字面文本 `/name `，宿主随后将其加载为 skill 的指令。加载是确定性的：宿主的 pre-step 边界（`dsh-tool-skill`）识别发出消息中以空白为界的 `/name` token，并为每个入口注入渲染后的 `<skill_content>`，因此菜单 pick、手动键入的 token 与 TUI/ACP 提示词都以同一种方式加载 skill。已结算的 skill 调用在对话中渲染为可展开的 `Instructions` 卡片，只从冻结的调用/结果切片派生。

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

在编辑器中输入 `/` 并从建议中选择 skill，或直接键入 `/name`；发出的消息携带字面文本，宿主对菜单 pick 与手动键入的 token 以同样方式加载 skill。与宿主命令同名的名称仍解析为命令——裁决在客户端把该行认领走，它根本不会成为提示词。

### source 提供什么

普通会话的候选来自 `skills/list` Remote；宿主提供每一个用户可调用的 skill，`modelInvocable: false` 的条目（即 `disable-model-invocation` skill，此路径是其唯一入口）会以当前语言把仅限用户标记作为描述前缀带上。结果经 `/` 菜单共享的名字排序器（ui-primitives 的 `rankByName`）排名：查询作为不区分大小写的有序子序列匹配 skill 名，前缀命中排最前，同分保持宿主顺序（[排名决策](../../../.agents/notes/archived/feature/2026-08-04-web-slash-command-fuzzy-discovery.md)）。`skills/list` 调用失败时会被记录并静默丢弃该菜单组——菜单只显示 pending/ready 状态。

### skill 工具行

收起的行显示 skill 图标、`Skill` 标题与请求加载的 skill 名称；运行中的调用带有 transcript 的扫光效果，失败时用错误首行替换名称，中断的调用使用警告状态。已结算的行展开为一个尺寸受限的 `Instructions` 卡片，其中原样呈现持久化的工具输出；可用时还会提供标准轨迹的 `Inspect` 入口。该行的名称、生命周期与正文只派生自 ui-tool 提供的冻结调用/结果切片，绝不读取当前目录，因此即使已安装的 skill 或其描述发生变化，回放仍保持稳定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

source 不实现任何裁决钩子，也没有引用 codec：pick 落下字面文本，发出的提示词中也是同一段字面文本，因此确定性在宿主侧（[slash 流水线笔记](../../../.agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md)）。

### 候选流程

目录按普通会话缓存，拉取走 single-flight；scope 创建时的 `warm` 钩子预热该会话的缓存项，转发的 owner 事件 `agent-preset/selected` 丢弃该会话这一项（目录属于 preset，而空会话可能在预热之后才切换），`connection/reset` 清空全部缓存。由目录寻址的可继续 subagent 在客户端解析为没有 skill 候选，因为现有 skill RPC 要求会话已挂载；查看其持久化历史不得激活它。列表 RPC 使用插件注册时捕获的根上下文连接；草稿 chip 视觉由 `lexicon` 扫描派生。

### 注册

`/client` 导出接口只有插件主体（`apply`/`inject`）；source 对象是注册 effect 的内部实现。工具行把 `skill` wire 名称注册进 ui-tool 的 keyed `tool.call.toolview` slot。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖输入机制、工具行宿主与宿主侧 skill 工具。

- [ui-input-trigger](../ui-input-trigger/README.zh.md)——该 source 注册进的行内建议机制。
- [ui-tool](../ui-tool/README.zh.md)——承载 `tool.call.toolview` slot 的工具调用展示层。
- [tool-skill](../../skill/tool-skill/README.zh.md)——拥有 pre-step 手势边界的宿主侧 `skill` 工具。
- [Web 输入机器与 slash 流水线](../../../.agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md)——引用与命令如何共享输入机器。

-----

<a id="model-experience"></a>
## 模型体验

### 用户显式 skill 调用

#### 模型看到的内容

用户消息原样到达模型，字面文本 `/name` 也包含在内。随后宿主的 pre-step 边界（`dsh-tool-skill`）把规范的 `<skill_content>` 块——与 `skill` 工具返回的 `renderSkillContent` 输出相同——作为注入的指令上下文追加在该步骤各项注入的末尾，最贴近模型的回答。加载是确定性的：模型无需被要求调用 `skill` 工具就能收到完整正文，目录也会告诉它不要重新加载已内联注入的 skill。

#### Token 影响

一次调用会把渲染后的 skill 正文作为注入上下文加进该轮次——成本与模型经由工具加载该 skill 相同，只是无条件支付，而非由模型自行裁量。浏览菜单和拉取候选不会增加任何模型 token。

#### KV Cache 影响

仅追加：注入的消息落在可复用历史前缀之后。该包绝不改写较早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义引用与工具行何时回退到通用行为；它们是当前包约束。

- **仅含工具结果的 history 页使用通用行**：键控分派要求配对的工具调用位于运行时窗口内；分页将工具调用留在窗口外时，工具结果没有工具身份。这项客户端呈现功能不会为了恢复该身份而扩展 history 协议约定。
- **文本是唯一依据**：引用是普通的草稿文本；手动键入的相同 token 就是同一个引用，宿主手势边界评判的是发出的文本，而不是菜单交互。chip 视觉由 lexicon 扫描派生；提示词协议上没有 occurrence 身份、位置跟踪或结构化引用载荷。
- **预热落定之前打开的菜单**：在那次击键下不显示 skill 候选；下一次击键会重新轮询已落定的缓存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。slash source、locale dictionary 与 keyed toolview 都由 registry 持有，HMR 测试覆盖释放；它们不发出 Cordis 事件或持有跨插件可变状态。
