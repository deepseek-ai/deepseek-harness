# Agent Note: 规则驱动的 IM 分派移出 v1 包集合

Status: implemented

[English](2026-10-27-im-dispatch-out-of-v1.md) | 中文

IM 已不再随附专用 profile、按聊天会话、任务 worker、单次命令示例或轮次渲染器：该决策记录在 [IM 以实验性组合包运行一个共享会话](../simplification/2026-10-28-im-shared-session-minimal-plane.zh.md)；下文涉及这些插件的部分描述的是它们当时遵循的设计。

## Problem

`dsh-im-session-dispatch` 承载了 IM 平面的大部分复杂度：为模型编写的路由规则编译到 WebAssembly 的 QuickJS 沙箱、自己的 `im_rules` 存储 unit、把消息从分派者手中拿走的 `copy`/`cut` 路径、双向的规则通知，以及九个分派者工具与五个 worker 工具。只有一个部署使用它。`dsh-im-session-tasks` 与它以及平台线程耦合：它发布话题公告，在没有线程的平台上退化为 `#task` 消息，从第一条回复学习线程 id，并监听 `im/message` 路由话题回复，其中 `topicDelivery: rules` 模式只为分派者存在。

## Decision

规则驱动的分派者移入唯一使用它的部署插件，位于本仓库之外，规则语言与存储保持不变。在本仓库中：

- [`dsh-im` 宿主](../../../../packages/experimental/im/src/dispatcher.ts) 增加了一个最小默认行为：配置 `dispatcher` 后，没有监听器处理的、找机器人的消息进入所有聊天共用的一个会话。它没有路由也没有规则；不配置时未处理的消息照旧被忽略。
- `dsh-im-session-tasks` 只负责启动和管理任务 agent。worker 在哪里作答由发起它的策略给出的放置决定（或由策略按 owner 名注册的放置函数决定）；默认放置把 worker 绑定到 owner 当前触发消息所在的聊天与线程。本包不发布任何内容，也不路由任何入站消息：希望后续消息到达 worker 的策略自行找到任务并调用 `deliver`。
- 输出渲染器在会话可写触发消息所在聊天时发布到该聊天，因此绑定多个聊天的会话会在被提问的地方作答。

## Alternatives considered

**在 v1 中保留不含 QuickJS 的分派。** 由 harness 维护的谓词语言仍需要自己的存储、通知和工具，而且仍然只有一个部署使用。

**把话题保留在任务服务中。** 哪些消息到达 worker 属于路由策略，路由属于拥有这些会话的策略；否则任务服务会在每个策略旁边再保留一个特定于平台的路由器。

## Consequences

运行过 `dsh-im-session-dispatch` 的部署改为挂载自己的插件与自己的分派预设；由于 unit 名与版本都未变化，其 `im_rules` 与 `im_tasks` 记录仍可读取。`topicDelivery` 不再是任务服务的字段，设置它的 profile 只会带一个被忽略的键。会话启动任务时不再开启平台话题，因此在 worker 回答下方的回复到达的是该会话而不是 worker。
