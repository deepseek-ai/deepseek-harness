---
description: "skill 提供方注册表，供选择、配置或排查来自任意来源的 skill 如何被合并、解析与加载的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill

[English](README.md) | 中文

## 概述

agent（智能体）和用户可以通过单一查找使用可复用的任务专项指令，无论指令来自何处：任意提供方都可以从本地目录、嵌入式插件数据或远程服务贡献 skill（技能），每个消费方都会收到一份合并目录——每个名称对应胜出的 skill——并能按需加载任一 skill 的完整指令。当组合需要从多个来源或非文件系统来源加载 skill 时，请挂载本插件；当组合完全不加载 skill 时，请跳过。它自身不携带任何 skill 内容——请至少搭配一个提供方（随附的 `dsh-skill-filesystem`）；需要 agent 加载 skill 时，再搭配 `dsh-tool-skill`。

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

挂载插件即可让组合拥有一个统一的 skill 注册表。skill 来源（提供方）和消费方（面向模型的目录与 loader，或你自己的代码）都通过 `ctx.skills` 交互；注册表合并任意提供方报告的一切内容，因此一次查找就能看到所有来源的 skill。

### 何时选择

当 agent 需要通过同一个接口从多个来源加载 skill，或 skill 来源并非本地文件系统时，选择 `dsh-skill`。当组合完全不需要加载 skill 时，请避免使用——插件会增加一个服务以及每次查找的发现成本。随附的本地提供方（`dsh-skill-filesystem`）和面向模型的消费方（`dsh-tool-skill`）是独立包；部署需要本地 skill 和模型访问时，请一并挂载。

### 挂载与配置

像任何 Cordis 插件一样加载即可。唯一配置项限制内存中保留的已完成提供方目录数量；其余都是提供方行为。

```yaml
- name: '@deepseek-ai/dsh-skill'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `collectCacheMaxEntries` | `128` | 内存中保留的已完成 cwd/提供方目录数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-skill)是每个受支持字段的穷尽式真源。

### 注册表提供什么

- **合并后的单一目录。** 消费方查询工作区的当前目录，即可收到来自所有提供方的全部胜出 skill 摘要，并按名称排序——无需自行做提供方特有的排序或去重。
- **按需加载。** 按名称查询某个 skill，会从拥有胜出候选项的提供方返回完整指令正文；注册表会重新验证加载的定义，并拒绝在发现与加载之间名称发生变化的陈旧选择。
- **嵌入式 skill。** 插件可用 `ctx.skills.register(...)` 注册内存中的 skill；注册表会补入默认调用策略与 `runtime` 提供方标签。同层同名运行时注册采用先到先得，并记录警告。
- **提供方注册。** 提供方用 `ctx.skills.registerProvider(...)` 贡献目录；注册是同步的，返回的 disposer（资源释放）会移除该提供方。`runtime` 是保留的提供方名称。

每个 skill 上的调用策略决定哪些接口可以展示并加载它：`modelInvocable` 用于面向模型的工具与目录，`userInvocable` 用于面向用户的命令。注册表保留全部四种组合，因此一次发现结果可以同时服务两个接口，而不会混淆各自的目录。

| 策略 | 模型 | 用户 |
|---|---|---|
| `{ modelInvocable: true, userInvocable: true }` | 包含 | 包含 |
| `{ modelInvocable: true, userInvocable: false }` | 包含 | 排除 |
| `{ modelInvocable: false, userInvocable: true }` | 排除 | 包含 |
| `{ modelInvocable: false, userInvocable: false }` | 排除 | 排除 |

### 可观察的成功与失败

任意提供方报告的 skill 都会出现在合并目录中，按其精确 kebab-case 名称加载即可返回正文；无效名称返回无结果而非抛错。发现失败的提供方会被记录并跳过，观测被标记为不完整，因此消费方保留其最后一份可用目录；显式的不完整观测仍会贡献其候选项。格式错误的候选项会快速失败——注册表在缓存或返回任何内容之前，会先验证名称、描述、调用布尔值与提供方归属。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释注册表如何合并、缓存并失效提供方目录；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在一个分离之上：注册表负责合并、胜出解析与验证，提供方负责 skill 来自哪里。提供方是借用的同进程对象，其 `list()` 返回候选项、`get()` 加载正文；注册表除验证语义字段外，从不检查 skill 内容。

注册表采用宿主 + 按 scope 的分层结构，即工具注册表确立的形态：注册落入调用方上下文 scope 对应的层——宿主行与 repository 插件落入全局层，由 agent preset 常驻组合挂载的插件落入该 preset 的层。读取时将全局层与观察 scope 的链合并；最近层直接赢得重名，单层内重名则依次按 rank、提供方注册顺序与提供方本地顺序裁决。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、`SkillRegistry` 服务、候选项与定义验证、共享的面向模型渲染 |
| — | 不发布运行时不变式伴生入口；provider/runtime map 与带 revision 的 cache 在 registry 内原子变更，且没有独立 change event 或 snapshot 可供交叉核对。 |

### 目录收集

读取（`list`/`snapshot`）会收集每一层的候选项：先是运行时 skill，再是各提供方的 `list()` 结果，提供方依次等待、失败被包含。候选项经验证后在层内去重，跨层合并；摘要按名称排序。完成的收集按 cwd、scope 链与 revision 缓存，上限为 `collectCacheMaxEntries`；读取中途提供方或运行时变更使 revision 递增时，进行中的收集会重试一次，第二次变更则返回最新候选项并标记为不完整、不予缓存。

### 加载与陈旧

`get()` 选择胜出候选项，让提供方加载与查找的中止信号竞速，并在选择或缓存命中后重新检查取消。返回的定义必须与所选候选项同名；名称不符会使缓存目录失效，以便下一次快照重新发现该提供方的 skill。定义从不缓存——每次加载都向提供方请求当前正文。

### 失效

注册表没有 TTL：只有提供方调用其注册作用域内的 `invalidate()`，或发生运行时注册或释放时，才会清除已完成的目录。每次失效都会递增 revision、清空缓存，并发出不带过滤条件的 `skills/change` 事件；消费方用各自的查找选项重新获取。`invalidate()` 仅当接收它的那条精确注册仍处于活动状态时才生效，因此延迟回调无法干扰同名替代提供方。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享的 skill 词汇逐步进入随附提供方、面向模型的消费方与设计依据。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——注册表、提供方约定与本地发现优先级。
- [skill-filesystem 包](../skill-filesystem/README.zh.md)——从磁盘发现 skill 的随附本地提供方。
- [tool-skill 包](../tool-skill/README.zh.md)——渲染会话目录与 `skill` 工具的消费方。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-skill)——每个配置字段及其源声明。
- [skill 调用策略 Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-skill-invocation-policy.zh.md)——模型与用户调用控制的依据。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；该包将提供方摘要渲染到持久的初始目录或替换目录消息中，并将加载的指令正文渲染到已保留的工具结果中。

#### KV Cache 影响

不直接影响提示词。指定的消费方负责持久初始目录，以及失效后的仅追加式目录替换。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **失效由提供方驱动**——注册表没有 TTL，无法推断任意远程来源是否已发生变化；每个可变提供方都必须保留其注册作用域内的 `invalidate()` 能力，并由自身的观测机制调用它。
- **提供方依次查询**——一个缓慢的提供方会延迟其后注册的所有提供方；取消会停止调用方的等待，但无法终止不响应取消的提供方持续运行的工作。
- **不保留不完整观测**——被拒绝的提供方会被省略，显式提供的候选项也仅在当前查找中可用；注册表既不负责最后一份可用目录，也不负责逐提供方诊断。
- **重名项的裁决采用先到先得**——系统会记录并隐藏层内较晚出现的低优先级候选项，较近的层会静默遮蔽较远的层；没有 API 可检查全部被遮蔽的定义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制以上文和代码为准。一个开放问题是：注册表是否应保留最后一份可用目录或逐提供方诊断，还是由消费方拥有该状态；「不保留不完整观测」限制记录了当前答案。

</details>
