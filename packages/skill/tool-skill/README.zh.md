---
description: "面向模型的 skill 目录与加载工具，供了解 agent 看到什么、或配置会话 skill 目录的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

[English](README.md) | 中文

## 概述

agent（智能体）可以在会话期间发现并加载 skill（技能）：在首次请求前，它们会收到一份持久目录，列出每个可用 skill 的名称与有长度上限的描述，并可通过 `skill` 加载工具按名称加载任一列出 skill 的完整指令。用户也可以用 `/name` token 直接调用某个 skill，把该 skill 的指令注入当轮次。目录保持最新：成员关系、描述或可见性变化会追加完整的替换目录，被删除的 skill 会被显式停用。当 agent 需要加载 skill 时，请把它与 skill 注册表（以及至少一个提供方）一起挂载；它唯一的配置项限制目录描述长度。

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

与 skill 注册表一起挂载该插件，即可让 agent 拥有会话 skill 目录和 `skill` 加载工具。它需要 `ctx.agents`、`ctx.tools` 与 `ctx.skills`。

### 何时选择

当 agent 应在会话期间发现并加载 skill 时使用它。当 skill 加载由其他消费方处理或完全不需要时，请跳过——没有它，提供方与注册表仍可工作，但不会有任何东西为模型渲染目录或工具。

### 挂载与配置

与 skill 注册表和至少一个提供方一起加载该插件。唯一配置项限制目录中渲染的规范化描述长度。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `catalogDescriptionMaxLength` | `500` | 会话目录中渲染的规范化描述最大长度；最小为 3 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-skill)是每个受支持字段的穷尽式真源。

### 模型得到什么

- **会话目录。** 当存在模型可调用 skill 且 `skill` 工具可见时，agent 会在首次请求前收到一条持久的用户角色消息，列出每个 skill 的名称与有长度上限的描述；该消息告诉模型在着手任务前先用工具加载 skill，且绝不能仅凭摘要推断指令。
- **加载工具。** 模型以精确的 skill 名称调用 `skill`，并收到完整指令正文以及规范的 `<skill_content>` 块中的资源指引；该结果作为普通工具历史保留。
- **用户显式调用。** 直接用户输入中的 `/name` token 若指名某个用户可调用 skill，会把该 skill 的指令注入当轮次，而无需模型自行加载。
- **实时目录更新。** 后续成员关系、描述或可见性变化会追加完整的替换目录；删除全部 skill 时会追加空目录，停用较早的名称。

### 可观察的成功与失败

加载列出的 skill 会返回其完整指令；无论加载来自工具还是用户的显式调用，模型看到的都是同一种规范形态。无效名称会报告 `Error: invalid skill name "<name>"`，未知名称会报告该 skill 未知或已不可用，被禁用模型调用的 skill 会报告其不可用于模型调用。只有不存在模型可调用 skill 且从未发布过目录时，目录才会被整体省略；此后的可见性丧失——`skill` 工具被隐藏或被同名作用域工具遮蔽——会改为追加空目录来停用旧名称，与删除全部 skill 时相同。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释目录与调用边界如何构建；可观察行为已在[使用本包](#use-this-package)和下方模型体验章节中完整说明。

### 设计理念

本包建立在两个想法之上。第一，目录是一种持久投影，按已发布条目的 digest 而非渲染后的正文做差异比较，因此 `<system-reminder>` 包装永远不会强制重新发布，消费方也不需要重新解析 `<available_skills>` 块。第二，一条规范渲染服务两条加载路径——工具结果与用户显式注入——经由共享自 `dsh-skill` 的 `renderSkillContent`，因此无论加载由谁发起，模型看到的都是同一种 `<skill_content>` 形态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、目录与手势 pre-step 监听器、渲染与 digest |
| — | 不发布运行时不变式伴生入口；这个模型侧 adapter 没有独立 lifecycle stream；执行关系由它调用的 capability seam 负责。 |

### 目录生命周期

在每次符合条件的 `agent/pre-step`，插件都会快照调用会话的 skill 目录，应用 `skill` 工具的精确可见性，过滤出模型可调用的 skill，并把条目 digest 与会话日志中最新可见的 `skill-catalog` 消息做比较。digest 变化时，它把包含完整替换目录的持久用户角色消息交给 `enter` 决策；空替换会显式停用较早的名称。提供方快照不完整时不发送任何内容，并为下一次 pre-step 保留最后一份可用视图。可见性检查针对本插件所注册的精确工具定义，因此作用域内同名的遮蔽项会同时移除 schema 及其指引；该插件既可全局挂载，也可挂在单个 agent 的组合内。

### 调用边界

`/name` 手势监听器只扫描已认领的用户消息：若某个以空白为界、指名工作区目录中用户可调用 skill 的 token 出现，则把同一份 `<skill_content>` 渲染作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后。未知名称与用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录与 `skill` 工具永不暴露这类 skill。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从目录背后的注册表词汇逐步进入精确工具 schema 与设计依据。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——目录背后的注册表与提供方词汇。
- [skill 包](../skill/README.zh.md)——注册表与共享的 `renderSkillContent` 渲染。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)——模型接收的精确 `skill` schema。
- [skill 目录热刷新 Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-skill-catalog-hot-refresh.zh.md)——持久初始目录与替换生命周期。
- [用户显式 skill 调用 Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-user-explicit-skill-invocation.zh.md)——`/name` 手势设计。

-----

<a id="model-experience"></a>
## 模型体验

### 会话目录

#### 模型看到什么

如果存在模型可调用 skill，且可见的正是这个 `skill` 工具，agent 会在第一个请求之前收到下方目录模板，其中包含每个已排序 skill 的一条随数据而定的条目。该目录是一条持久的用户角色消息。后续成员关系、描述或可见性的变化会使用同一个 `<available_skills>` 信封追加完整替换；删除所有 skill 时，会追加一个空信封，并明确指示不得使用旧名称。模板的结尾一句是防止双重加载的规则：用户显式的手势边界（下文的 pre-step 监听器）会把同一份 `renderSkillContent` 输出（共享自 `@deepseek-ai/dsh-skill`）内联注入，目录则告诉模型遵循该块，而不是再经工具重新加载该 skill；替换目录模板的两个分支——包括清空后的目录——都携带同一条防双重加载规则。

##### Skill 目录模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token 影响

重复输入成本随 skill 数量和 `catalogDescriptionMaxLength` 增长；当列表为空或工具被隐藏或遮蔽时，不会发送初始目录 token。每次实际目录变更都会添加一条保留的完整替换消息。

#### KV Cache 影响

初始持久目录追加在现有可重用前缀之后。动态变更作为该目录之后的仅追加历史，因此较早的可重用 token 保持不变，每条新追加的目录和后续轮次都会形成新的后缀。新建或恢复的实例如果 digest 发生变化，可能会从新追加的目录位置起影响缓存重用。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`skill` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)。

#### Token 影响

工具可见时，每次请求都有固定的 schema token 开销。

#### KV Cache 影响

工具定义和可见性不变时，前缀稳定。遮蔽、限制或插件生命周期变更可能从该 schema 起使重用失效。

### 工具结果

#### 模型看到什么

成功调用使用下方结果模板，以及提供方管理的资源指引、目录资源指引、URL 资源指引或不透明资源指引。

##### Skill 结果模板

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### 提供方管理的资源指引

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### 目录资源指引

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL 资源指引

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### 不透明资源指引

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token 影响

已加载指令是取决于数据的工具结果 token，并在后续步骤中重新发送，直到压缩；不会制作重复的 `agent.inject()` 副本。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到什么

无效或陈旧选择会精确返回 `Error: invalid skill name "<name>"`、`Error: skill "<name>" is unknown or no longer available` 或 `Error: skill "<name>" is not available for model invocation`。提供方抛出的查找文本取决于数据，并套用同一个 `Error: <message>` 包装层。

#### Token 影响

只有失败调用会添加这些已保留 token。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 用户显式调用注入

#### 模型看到什么

已认领用户消息中任意位置、以空白为界、指名工作区目录中某个用户可调用 skill 的 `/name` token，会把该 skill 的完整 `<skill_content>` 渲染（与上文结果模板完全相同的形态）作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后——背景在前，模型要着手处理的材料在最后。只扫描直接的用户输入，检查在已加载定义上进行，未知名称和用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，目录和 `skill` 工具永不暴露这类 skill；目录的结尾一句会告诉模型遵循注入块，而不是重新加载它。

#### Token 影响

每次手势会把一份渲染后的 skill 正文作为注入上下文加进该轮次——尺寸与同一 skill 的工具结果相同，该成本会随用户请求必然产生，而非由模型自行决定。同一步骤内对同一 skill 的重复手势只注入一次。

#### KV Cache 影响

仅追加；注入落在该步骤的消息批次中、可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明目录或加载器何时不合适。它们是当前包约束，不是任务积压。

- **目录省略 `whenToUse`、来源和提供方元数据**——路由只基于名称和有长度上限的描述；`whenToUse` 仍是提供方元数据，加载后的包装层也不渲染它。
- **已加载指令正文没有大小上限**——提供方可返回足以占用大量下一步上下文的 skill；只有目录描述会被截断。
- **资源是指引，而非附件**——工具报告基础目录/URL/不透明提示，但既不列举也不为模型获取引用文件。
- **加载是一次性文本**——远程提供方缓慢或 skill 正文很大时，不提供部分内容、流式输出或缓存内容句柄。
- **目录替换采用全量列表**——一个名称或描述发生变化，就会追加所有可见摘要；这样能显式停用陈旧名称，但 token 成本与目录大小成正比。
- **正文不做版本化**——仅修改正文不会改变目录 digest，也不会通知模型；后续工具调用会读取提供方的当前内容，而先前工具结果仍是历史事实。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
