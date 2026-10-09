# Agent Note: 思考正文的标准 Slot 与可复用 Content Factory

Status: implemented

[English](2026-10-09-reasoning-content-slot-factory.md) | 中文

## 问题

思考正文需要允许第三方替换或包装展示，同时复用官方的 Markdown、本地化文案和紧凑排版。将扩展做成可选的 renderer 参数，再由宿主选择直接渲染或 chain fallback，会让默认正文存在于注册体系之外，插件也只能另行维护 Markdown 调用。

渲染位置与基础实现是两种不同的能力：位置允许多个插件注册并由框架选中一个，实现则应允许任何组件直接调用。调用基础实现不应再次触发该位置的插件选择，也不应要求 Session。

## 决策

沿用现有 [Component Factory](2026-09-10-component-factories-and-local-slots.zh.md) 和普通 Slot，不增加框架分发机制。

| 名称 | 类型 | 所有者与职责 |
| --- | --- | --- |
| `conversation.chat.reasoning.body` | `single`、`session` Slot | Assistant 节点注册声明的正文位置；展开时只接收原始文本与流式状态。 |
| `conversation.chat.reasoning.content` | `root` Factory | `ui-chat` 提供的标准思考正文；接收文本、流式状态及可选 labels，提供默认文案并固定 `variant="compact"`。 |

Factory 不接收 Session 身份，不读取 Session，不持有翻译状态。现有 Factory API 要求填写 `scope`，使用 `root` 表达无 Session 依赖；每个调用位置仍有独立的 React 实例。Factory 由 Chat 插件注册，而非依附于某个 Body occupant，第三方替换正文不会撤掉基础实现。

### 注册与调用

1. `ui-chat` 注册 Content Factory，组件 props 由 `FactoryComponentPropsOf` 推导。调用者未传 labels 时，Factory 使用 Chat 的 locale seat 构造稳定的默认文案。
2. Assistant 节点注册声明 Body Slot。`ReasoningRow` 展开时只调用 `renderSlot`，不接收可选 renderer，不提供内联 fallback，也不判断插件是否启用。
3. 官方以 `priority: 100` 注册普通默认 Body。该组件只将 `text`、`running` 传给 Content Factory。
4. 第三方通过 `slots.inject` 等待 Body 声明，以较小的 priority 注册自己的 Body。第三方可直接调用 Content Factory，并在外层增加自己的控件；无需导入官方私有 React 组件。
5. 第三方注销后，框架重新选中官方默认注册项。多个第三方注册遵循现有 single 优先级，不形成 middleware，也不同时渲染多份正文。

```text
ReasoningRow
  └─ conversation.chat.reasoning.body
       ├─ 官方默认 Body ───────────┐
       └─ 第三方 Body → 自有控件 ─┤
                                  └─ conversation.chat.reasoning.content
                                       └─ MarkdownText
```

正文调用位置：

```tsx ignore-check
<div className={css.thinkBody}>
  {renderSlot('conversation.chat.reasoning.body', { text, running })}
</div>
```

默认 Body 与第三方包装都使用同一个可复用实现；第三方需要自定义文案时传入 labels：

```tsx ignore-check
renderFactorySlot('conversation.chat.reasoning.content', {
  text: displayText,
  running,
  labels,
})
```

### 数据、状态与生命周期

- `ReasoningBodyOwnerProps` 仅包含只读的 `text: string` 与 `running: boolean`。`ReasoningContentInput` 另外允许 `labels?: MarkdownLabels`；传入的文案原样使用，不做字段级合并，省略时才使用官方默认文案。调用者负责自定义文案的本地化与引用稳定性。
- Body 的 `text` 始终是原始思考。第三方选择原文或派生显示文本后，只将该值交给 Factory，不改写 Session 或 Chat projection。
- 折叠状态、摘要、流光和标题由 `ReasoningRow` 保持现有行为。插件自己的切换状态、按钮及样式留在其 Body 包装中；官方不提供 `setHeaderAction`、标题动作类型或相应状态。
- 注册沿用 Cordis effect 生命周期。Body 声明撤销时，其贡献随 `slots.inject` 清理；Content Factory 在 Chat 插件卸载时撤销。
- Factory 组件与默认 Body 使用模块级稳定身份，文本变化作为 props 更新，不以文本重建组件类型或 key。插件替换或 HMR 可按现有框架语义重新挂载，不承诺保留被卸载组件的本地状态。

### 翻译插件接入

[免登录翻译设计](2026-10-05-anonymous-reasoning-translation.zh.md)保留外部请求、隐私、失败与取消决策；其正文组合方式由本方案取代。翻译插件注册到标准 Body Slot，在自己的工具栏内渲染原文／译文切换、状态及重试按钮，使用自己的状态和可选自定义 labels 包装官方 Content Factory，不直接调用 `MarkdownText`。

翻译请求、分片、缓存、持久化和设置保持不变。翻译切换按钮属于插件正文，不再由官方思考标题承载；不增加正文外的 Slot，不处理用户消息遮挡，也不改动通用 Markdown 解析器。

## 考虑过的替代方案

**翻译专用 chain 与宿主 fallback。** 默认内容不是普通注册项，宿主需要维护第二条渲染路径，第三方无法直接复用完整的官方正文实现。

**只开放 Body Slot。** 可以替换正文，但第三方包装时仍需复制官方 Markdown 调用、labels 与 variant。

**只提供 Content Factory。** 可以复用实现，但缺少允许第三方注册替换的实际正文位置。

**跨插件导出 React 组件。** 绕过现有 Factory 的加载、生命周期与类型推导，增加 feature-plugin 运行时依赖。

**将 Factory 命名为通用 Markdown。** 该实现固定思考正文的紧凑排版，并提供 Chat 默认文案，不是所有 Markdown 场景的通用入口。

**官方替插件维护标题动作。** 官方默认正文没有该需求；保留专用 setter 会让宿主承担插件的状态、清理与按钮样式。

**Factory 强制使用官方 labels。** 默认文案不应阻止调用者定制；可选参数即可表达覆盖，无需替换整套正文实现。

## 验证

- 正文宿主只调用 `conversation.chat.reasoning.body`，没有旧 `reasoning-body` chain、可选 renderer 或内联 Markdown fallback。
- 官方默认 Body 和翻译 Body 都通过 `conversation.chat.reasoning.content` 渲染；未传 labels 使用官方默认文案，传入自定义 labels 则原样交给 Markdown。
- Factory 在没有 Session Provider 的调用位置也能使用；两个调用位置不共享组件本地状态。
- 官方不存在标题动作类型、setter、状态或专用样式；翻译包装自行提供切换与重试控件。
- 翻译插件启用、停用及 HMR 后，框架选中对应 Body；默认输出、原文访问、流式展示、折叠和取消行为保持一致。
- 单元与装配测试覆盖注册撤销、无 Session Factory、labels 缺省与覆盖、默认与第三方共用实现及双实例；已有浏览器回放覆盖默认正文和翻译切换。

## 后果

旧 Slot 名称、chain selector 注册及标题动作回调不再受支持，第三方需要迁移。测试夹具与 Client inspect catalog 必须同步到新声明，避免仍向插件开发者提供旧注册方式。

Body 仍是独占替换位置。此方案不解决多个正文转换插件的自动组合，也不将显示变换提升为脱敏或模型输入修改能力。
