# Agent Note: Conversation 独占匹配

Status: implemented

[English](2026-10-12-exclusive-conversation-matches.md) | 中文

## Problem

每个事件 Definition 各自独立地匹配每个事件，同一个 target 上可能有一个呈现整类事件的通用 Definition。业务 Definition 自己呈现这类事件中的一种时，两个 Definition 会命中同一个事件，各自建立 Context 和 Node。业务 Definition 没有办法声明这个事件在该 target 上归它呈现。

迟到的问题回答是已上线的实例。Chat 的通用 `input-message` Definition 匹配每条追加的 `user/message`，问题 UI 的 `question-reply` Definition 也匹配它要呈现的回答消息。Chat 过程分组因此在有轮次归属和无轮次归属两条路径上都按消息 id 丢掉重复的 `turn-trigger` 呈现，并把整轮控件锚到组首成员，让它留在回答之上。重复的 Node 仍留在 Node Store 中，通用 Definition 也仍把回答当作 context 或触发通知。

## Decision

match 结果可以在 Definition 的 target 上认领它的事件：

```ts
interface ConversationMatchResult {
  readonly id: string
  readonly role: 'start' | 'update'
  readonly exclusive?: true
}
```

- **派发。** `ConversationNodeAssembler.dispatchInput()` 先把一个事件的全部 match 求入两个复用数组，再结算认领，之后才逐个接收。被认领 target 上的其他 Definition 不为该事件建立 Context，该 target 的未匹配事件 fallback 也不运行；其他 target 的 Definition 与没有 target 的 Definition 照常接收。结果与注册顺序无关。实时追加和窗口收集共用这一派发。
- **失败。** 同一 target 被认领两次，或没有 target 的 Definition 发起认领，都会在派发时抛错，错误信息包含事件、其 `seq` 与认领方 Definition 的 kind。
- **范围。** 认领只对一个事件生效，由 `match()` 返回，因此 Definition 只认领它识别出的事件；通用 Definition 不需要声明任何东西。
- **当前用法。** `question-reply` 对已记录的 `user-question-reply` 消息返回 `exclusive: true`。Chat 不再按消息 id 聚合，回答的放置不变。

## Alternatives considered

**Definition 优先级（`specific` / `default`）。** 通用 Definition 得声明自己可被覆盖，派发也变成优先级排序，而不是声明由哪个 Definition 呈现事件。认领不要求改动通用 Definition，两个认领冲突时直接失败，而不是静默排序。

**用注册表声明真人来源，并通过用户文本规则渲染回答。** 回答会保持为通用消息 Node，只定制文本。Chat 的 message 与 Inbox Definition 需要一个依赖 service 的判断函数，注册表变化必须重新组装所有已绑定的 Conversation，文本规则还要把消息来源当作 fact 读取。认领让回答留在它自己的 Definition 中。

**在持久数据中标记真人撰写的来源。** 消息来源上的通用字段可以让通用 Definition 自行分类回答，但这会改动持久化类型，已发布版本记录的回答也不带这个字段。

**在 `input-message` 中跳过回答的 kind。** 通用的 Chat Definition 会点名插件的来源 kind。

**在分组输出层去重。** 这是被替换的机制：重复 Node 仍留在存储里，对其他所有 Chat 读取方可见，每条分组路径都要重复这一聚合。

## Consequences

- 被认领的事件在每个被认领 target 上恰好只有一个 Context，Node Store 中不再残留隐藏的重复节点。
- 认领冲突在派发时失败，而不是在注册时失败，因为认领由事件数据逐个决定。
- 派发对每个事件的 match 多遍历一次，通常一到三个；没有认领的事件不产生额外分配。
- 插件在一个 target 上呈现通用 Definition 事件族中的一部分时，使用认领即可，不需要通用 Definition 配合。

## Testing

- `packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts`（"exclusive matches"）：两种注册顺序与实时追加下，认领都会对同 target 的其他 Definition 屏蔽该事件；其他 target 与无 target 的 Definition 照常接收，fallback 不运行；两次认领与无 target 认领会抛错。
- `packages/client/ui-user-questions/tests/question-reply.client.spec.ts`：回答的 match 认领其事件；同时持有两个消息 Definition 的 assembler 只为回答产生一个 Chat Node。
