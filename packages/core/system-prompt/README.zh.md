---
description: "面向用户与维护者的系统提示词组装说明，用于添加提示词段、变量、工具 schema 来源或配置面向模型的提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-system-prompt

[English](README.md) | 中文

## 概述

`dsh-system-prompt` 组装有序提示词段、运行时事实、变量和工具 schema。每个 Session 只接收新增或变化的系统文本；未变指令保留在历史中。Cordis 生命周期决定已注册来源是否活跃。同名注册支持作用域覆盖。无效的完整提示词组合和未解析变量会使组装失败。

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

在任何运行 agent 的地方挂载 `dsh-system-prompt`：它提供 `ctx.systemPrompt`，即每个提示词贡献所落入的注册表。通过 `agent.ctx` 注册只向该 agent 贡献内容。同名段以最近的作用域为准；同一作用域中，最后一个活跃注册优先。兄弟作用域互不影响。

<a id="configure-the-prompt"></a>
### 配置提示词

`sessionProjections` 是必需依赖；服务激活会等待系统状态投影注册完成。

配置拥有固定开场白、runtime 上下文、部署 persona 前缀与后缀与工具顺序；其余一切来自已注册的贡献。

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: true
    includeRuntimeContext: true
    personaPrefix: 'You are the deployment assistant.'
    toolOrder: ['<unlisted-tools>']
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `includeHarnessIdentity` | `true` | 是否包含顺序为 −1000 的第一方固定开场白 `You are an AI agent powered by DeepSeek Harness.`。仅当兼容性部署拥有完整系统提示词时设为 false。 |
| `includeRuntimeContext` | `true` | 是否在组装中包含可选的有序动态 runtime 上下文 |
| `personaPrefix` | `''` | 全局 persona 前缀模板，顺序为 `0`，位于第一方指导之前 |
| `personaSuffix` | `''` | 全局 `deployment:persona-suffix` 模板，顺序为 `10200`，位于第一方指导之后 |
| `toolOrder` | — | 显式面向模型工具顺序，含一个 `'<unlisted-tools>'` 其余项标记 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-system-prompt)是每个受支持字段的穷尽式真源。没有恰好一个其余项或存在重复项的 `toolOrder` 列表会在加载时失败；已列名称没有对应已注册工具会使每次 `assemble()` 被拒绝。

### 贡献提示词段

段包含稳定的 `name`、静态或按上下文解析的 `text`，以及有限的 `order`。

每个段在插值后、比较、渲染或记录前移除首尾空白，包括字面段和完整提示词段；内部空白保持不变。仅首尾空白变化不会发送更新，仅含空白的文本遵循空文本准入规则。替换和退役通知也会移除首尾空白；退役通知必须仍为非空。

名称在更新、插件重载、恢复和派生中标识同一贡献。组装先按顺序值、再按名称的代码单元顺序排序。仓库贡献方使用 `getSectionOrder()`；运行时上下文使用 `getContextOrder()`。`complete: true` 段在组装中保持独占。进入或改变它时追加通知，说明从此刻起替代此前所有系统提示词段。离开时追加当前普通段，并明确同样从此刻起适用，包括此前被覆盖项抑制的未变段。此前消息保留原位置；空完整提示词显式撤回此前指导。

```text
ctx.systemPrompt.section({
  name: 'tool:bash',
  order: 100,
  text: 'Prefer bash for file and process operations.',
})
```

在段或动态上下文上设置 `interpolate: false` 可原样保留文本，包括生成的工具文档或目录名中的 `{{…}}` 组。其他贡献默认执行变量插值。

`refreshContext(assembly, context)` 在 pre-step 与路由准备之后刷新已注册的运行时事实。它保留已接纳的段、工具、变量及仅由组装 waterfall 添加的上下文，应用当前的可选上下文抑制，并恢复缺失的必需条目。将变化的事实放在上下文 provider 中；已注册上下文的文本会在准入前再次读取。

agent loop 在 `agent/pre-step` 之前为每个拟议步骤调用 `assemble(context)`，传入 Session、捕获的模型选择（`context.modelSelection`）和准入工具集合（`context.toolSet`）。结果为该 Session 固定段文本和生命周期。每次模型尝试前，循环追加 `assembly.systemUpdates(retry)` 返回的写入：首次尝试写入普通增量；压缩后的首次尝试（包括重试）写入重建的系统头节点。重试复用该组装，不重新求值段回调。提交前拒绝或取消不会改变已提交准入。组装后的来源变化留到下一次组装处理。展示监听器接收段、上下文与变量；工具声明仍由提供方持有。

调用返回的 disposer 或卸载所属插件时，Cordis 清理只移除对应注册。移除覆盖会显露下一个活跃定义，并按普通文本更新处理。只有当 Session 可见的作用域链中已无活跃注册，且该 Session 此前提交过此名称时，才会退役；通知来自该 Session 观察过的最后一个被释放的注册。可将 `retirement` 设为非空字面通知；省略时使用 `The earlier instructions from ${name} no longer apply.`。退役绝不调用已销毁生产方的回调。组装前销毁并重新注册同名段时，会将新文本与已提交文本比较；文本和顺序相同则不发送内容。

```text
ctx.systemPrompt.section({
  name: 'workspace:instructions', order: 100,
  text: () => currentInstructions,
  replacement: 'The workspace instructions have changed.',
  retirement: 'The workspace instructions no longer apply.',
})
```

### 贡献提示词变量

变量从段或上下文文本中以 `{{name}}` 引用，每次组装时解析；带作用域的变量会为该 agent 遮蔽同名全局变量。循环提供 `provider` 和 `model`；插件可注册自己拥有的事实。工作目录服务通过不执行插值的用户上下文提供目录文本。

```text
ctx.systemPrompt.variable('response_language', () => 'English')
```

自定义 persona 模板不得依赖内置 `{{cwd}}` 变量：循环不注册它，因此无法解析的引用会在任何模型请求之前使提示词组装失败。请从 home、profile 或单次调用的 `personaSuffix` 设置以及 preset 的 `suffix` 字段中移除 `Your working directory is {{cwd}}.` 语句，保留无关文本。后缀没有其他内容时，可省略或清空该字段。[工作目录服务](../../session/working-directory/README.zh.md) 提供必需的当前目录上下文。

### 贡献工具 schema

工具 schema 提供方在每次组装时求值，并贡献模型可见的 `ToolSchema` 集合；`ToolRuntime` 会自动注册自身，因此大多数工具在此无需手动接线。提供方返回限制后的可见集合，外加 `toolOrder` 使用的限制前名称全集。

### 抑制运行时上下文

`suppressRuntimeContext()` 移除调用作用域的可选动态上下文，但不禁用拥有这些事实的服务。标记为 `required` 的贡献仍然可见。多个抑制器独立组合；不再存在抑制器时，可选上下文恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该包是一个注册表加一条协作式组装流水线。一次 `assemble()` 调用把全局层与所请求作用域的层合并，分离工具参数，先按数值再按名称规范化段顺序，运行按作用域筛选的 `system-prompt/assemble` waterfall，把有效的 complete 段恢复为唯一的提示词段，并实施任何当前生效的运行时上下文抑制器。段与动态上下文是独立的输入：段成为提示词文本，而上下文在循环下成为模型历史中带来源的 user 角色快照。工具 schema 按设计属于组装结果——「模型获知自己能做什么」是一个连贯整体，尽管适配器把 schema 作为独立 wire 字段传输。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SystemPrompt` 服务、配置、组装流水线、`renderPrompt` |
| [`src/admission.ts`](src/admission.ts) | 根据捕获的段生成固定追加或重建决策 |
| [`src/projection.ts`](src/projection.ts) | 从日志恢复每个 Session 的已提交段与待执行压缩重建 |

### 组装与渲染

在普通增量组装中，从 waterfall 结果中省略已准入的段不会改变其已提交指令。返回空文本可撤回指令并保持来源活跃；销毁注册则使来源退役。

组装同时捕获来源定义和生命周期状态，再通过 waterfall 解析展示内容。`PromptAssembly.systemUpdates()` 在调用时将捕获的段与 Session 的已提交投影比较，返回带 surface 意图的 `system/message` 写入：普通增量为追加，重建一份完整提示词时为替换。没有 `context.session` 时，它不返回写入。`renderPrompt()` 用于检查时渲染完整展示内容。两条路径都对未设置 `interpolate: false` 的段执行变量插值、移除首尾空白，并拒绝未知或无值引用以及格式错误的完整组。

日志中的 `source.sections` 条目携带 `name`、`order` 和 `state`。活跃条目必须通过 `contentIndex` 指向其规范文本块，即使文本为空；退役条目省略此字段。可选的 `noticeIndex` 列出该来源的替换或退役通知块。所有索引都指向所在消息的 `content` 数组，索引不能重复，文本与通知也不能重叠。整体系统替代通知仍不归属任何来源。通知不参与文本比较。

每个段和通知各占一个去除首尾空白的文本块；适配器在渲染时选择分隔符。`source.reset` 替换已提交的段状态。记录压缩摘要后，需要根据下一次尝试的组装所捕获的段生成完整提示词，包含尚未提交的变化，但不附加替换或退役通知。即使组装被丢弃或应用重启，该要求仍保留，直到[循环提交重建后的头节点](../agent-loop/README.zh.md#understand-the-implementation)；空闲期间的检查视图在此之前保留原有指令。

系统投影保留已提交章节以及是否仍需重建；压缩摘要或不含 `source.sections` 的系统消息会设置该要求，带归属的重置会清除它。Session surface 根据实际替换位置而非来源引用，报告当前系统节点。重建读取有序系统节点，先清空非空增量，最后替换头节点。

### 作用域

组装从全局到最近作用域解析段名称，先选取各层最后一个活跃注册，再求值文本回调。带作用域的上下文和变量遮蔽外层值；工具提供方合并。Persona 前缀与后缀使用普通段注册；`persona` 插件覆盖两者，只注册前缀时则继承后缀。组装 waterfall 按作用域筛选分发。注册表变更通知（`system-prompt/change`）不经过筛选，因为全局变更影响每个作用域。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——确切的跨包类型与生成的服务 API。
- [tools 包](../tools/README.zh.md)——其 schema 流入组装的工具注册表。
- [提示词变量 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)——哪些提示词事实归谁所有。
- [第一方提示词顺序 Agent Note](../../../.agents/notes/archived/architecture/2026-08-25-sparse-first-party-prompt-section-orders.md)——稀疏具名顺序分配。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

首次接受的组装会在用户消息之前提交初始 `system/message`，即使所有段都为空。非空段提供其文本；空头节点保留在日志和表层中，但不产生模型请求消息。被拒绝的组装或提交前取消都不会写入系统头节点。后续准入追加文本或顺序变化的段，可在新文本前附上 `replacement` 通知。省略通知时会指出被替换的段；空通知省略此前缀。显式空文本更新使用其替换通知；未提供时使用默认撤回通知。只有所有可见注册均已释放，且此前已向该 Session 提交过来源时，才会发送退役通知，随后移出已提交投影。压缩后的下一次请求被接受时，组装重新求值活跃来源，在头节点提交当前指令，包括上次普通准入后的变更。运行时上下文仍是独立的带来源用户角色快照。

##### harness 身份

```markdown
You are an AI agent powered by DeepSeek Harness.
```

#### Token 影响

普通更新仅增加发生变化的段及其通知。压缩后的下一次请求使用当前系统头，保留的对话中已清除通知和被替代的指令。

#### KV Cache 影响

普通更新保留此前消息。路由变化、恢复、显式请求序列开始和工具 schema 变化不会归并各段。压缩用摘要替换选区；下一次模型尝试将当前指令归并到头节点。下一次普通准入将来源值与该已提交头节点比较。适配器按路由支持选择原生历史内消息、提醒消息或合并的系统字段；只有保留前缀的表示才能复用其缓存。

### 工具 schema

#### 模型看到什么

对于已交付工具，模型会收到[生成工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-executor-ptc)中对每个 agent 可见的子集；限制与步骤时激活完成后，按配置或字典序排列。扩展可以通过同一注册表贡献其他定义。段与 schema 提供方是独立的组装输入。限制不会移除段落注册：工具指导插件通过 `text({ scope, toolSet })` 与 `ctx.tools.get(name, scope, toolSet)` 返回空文本或选择适用片段。任意静态段落不会被自动改写。

#### Token 影响

schema token 在每次请求中重复。限制工具会为该 agent 移除其全部 schema 成本，但不会移除独立提示词段；重排序会改变缓存形状，但不改变语义内容。

#### KV Cache 影响

只要可见 schema 集合、渲染与顺序不变，前缀就保持稳定。注册、限制或重排序可能从第一个变化的 schema token 起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提示词组装何时需要特别留意。它们是当前包约束，不是待办事项清单。

- **部署方编写的提示词文本只来自配置／组合**：此插件注册部署 persona 默认值；组合插件通过 `section()` 覆盖其段名称。其他段属于拥有相应事实的插件。不存在终端用户提示词编辑 API。
- **来源生命周期仅保留在进程内**：应用重启会丢失尚未提交退役的已销毁来源定义。重启后缺席来源的早先指导可能保留在恢复后的历史中。
- **插值文本不支持行内转义语法**：整段需要保留字面花括号时，使用 `interpolate: false`。
- **`toolOrder` 配置错误在提示词组装（首轮）时出现，而不是启动时**：只有形状违规会在配置加载时抛出。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
