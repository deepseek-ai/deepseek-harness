# Agent Note: Fork child 保留 parent 请求前缀

Status: implemented

[English](2026-08-10-fork-children-stay-one-shot.md) | 中文

## 问题

fork 与 spawn 的差异在于：fork 会用 parent 已完成轮次的前缀作为 child Session 的种子。该种子会消耗 token，其预期收益是提供方侧的前缀复用：使用相同提供方和模型时，如果 child 请求的开头字节与 parent 相同，共享区段就无需再次预填充。任何位于继承历史之前、仅属于 child 的系统提示词 section 或工具 schema 都会破坏这项收益。

先前的随附组合通过把 fork child 保持为 one-shot 来避开这种不匹配。该限制源于原来的 child-only 返回工具，并非可继续 fork 的固有属性。

## 决策

共享 activation 入口、外部执行所有权，以及调用方与父级之间的结果投递选择由[统一 subagent activation](../simplification/2026-09-17-unified-subagent-activations.zh.md) 决策拥有。本记录保留下述独立理由。

面向模型的 `send_message` 工具在组合中的每个 Agent 上全局注册。因此，可继续 fork child 获得与 parent 相同的工具名称、描述、schema 和顺序。其初始任务追加在继承的 Session 种子之后；当 child 可以看到该工具时，任务还会包含直接 parent id，以及使用 `send_message({ agent_id, message })` 返回结果的指引。

base 组合包与 `cordis`、`standard` 和 `ptc` CLI preset 将 fork 绑定为可继续生命周期。基于 base 的 profile（包括 headless）继承这一默认值。`ForkInProcessProvider.prepareContinuable()` 与 `ctx.subagents.startActivation()` 在这些组合中保持相同的请求前缀行为。

逐字节相同的前缀复用取决于组装输入。结构化输出或生成 SDK 差异可以改变请求头。历史子级 descriptor 也可在冷恢复时恢复 persona 或工具限制；过滤掉 `send_message` 会同时移除其 schema 和返回指引。新 fork 启动继承父级 preset，不含这些覆盖字段。

## 考虑过的替代方案

**让所有 fork 保持 one-shot。** 这能保留前缀，但 child-only schema 差异消失后，继续放弃持久且多轮的 fork child 已无必要。

**安装 child-only 返回别名。** 无需填写接收方的别名可以缩短 child 调用，但会在继承历史之前重新产生工具 schema 与提示词差异，并重复相邻 Agent 操作。

**把返回指令放进系统提示词。** 这会在继承消息之前加入 child-only 字节。将其追加到初始用户任务，可以保留继承前缀，并让 parent id 紧邻需要它的任务。

**恢复时忽略历史子级 `toolFilter`。** 存储的限制必须继续决定 schema 可见性和指引；静默丢弃它会改变恢复 agent 的行为。

## 后果

- 使用相同 preset 且没有子级专属结构化输出或恢复的历史覆盖时，父级与可继续的 fork 子级公开逐字节相同、顺序一致的工具 schema。
- 继承的 Session 种子位于 child 初始任务及其返回指引之前。
- base 组合包与完整 CLI preset 对 parent 和 caller 投递均使用本地可继续 fork，不增加 child-only 请求头字段。
- child 可以通过 `send_message` 向直接 parent 发消息。parent 投递会追加独立的运行时结算通知；caller 投递通过 activation 回执返回结果。
- keyless snapshot 与包测试固定 schema 相等性、继承历史顺序、parent-id 指引，以及通过同一个 `send_message` 操作完成的 child-to-parent 投递。

### 已接受风险

提供方侧前缀复用仍取决于所选提供方和模型，以及组装输入是否相同。harness 测试的是自身组装请求头输入相等，而非提供方的缓存行为。
