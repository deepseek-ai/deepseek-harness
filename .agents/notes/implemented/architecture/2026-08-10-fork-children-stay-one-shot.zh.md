# Agent Note：Fork child 保留 parent 请求前缀

状态：已实现

[English](2026-08-10-fork-children-stay-one-shot.md) | 中文

## 问题

fork 与 spawn 的差异在于：fork 会用 parent 已完成轮次的前缀作为 child Session 的种子。该种子会消耗 token，其预期收益是提供方侧的前缀复用：使用相同提供方和模型时，如果 child 请求的开头字节与 parent 相同，共享区段就无需再次预填充。任何位于继承历史之前、仅属于 child 的系统提示词 section 或工具 schema 都会破坏这项收益。

先前的随附组合通过把 fork child 保持为 one-shot 来避开这种不匹配。该限制源于原来的 child-only 返回工具，并非可继续 fork 的固有属性。

## 决策

面向模型的 `send_message` 工具在组合中的每个 Agent 上全局注册。因此，可继续 fork child 获得与 parent 相同的工具名称、描述、schema 和顺序。其初始任务追加在继承的 Session 种子之后；当 child 可以看到该工具时，任务还会包含直接 parent id，以及使用 `send_message({ agent_id, message })` 返回结果的指引。

base 与 headless 组合保留 one-shot fork 作为其保守生命周期策略。`cordis`、`standard` 和 `ptc` CLI preset 可以把 fork 绑定为可继续生命周期，因为该绑定不再插入 child-only 请求头字段。`ForkInProcessProvider.prepareContinuable()` 与 `ctx.subagents.startContinuable()` 仍是这些 preset 使用的实现 seam。

逐字节相同的前缀复用受显式部署选择约束。配置 child persona 或 `toolFilter` 的 fork 委派仍可能改变请求头。尤其是过滤掉 `send_message` 时，child 会同时失去该 schema 与返回指引；运行时不会绕过显式 allow-list。

## 考虑过的替代方案

**让所有 fork 保持 one-shot。** 这能保留前缀，但 child-only schema 差异消失后，继续放弃持久且多轮的 fork child 已无必要。

**安装 child-only 返回别名。** 无需填写接收方的别名可以缩短 child 调用，但会在继承历史之前重新产生工具 schema 与提示词差异，并重复相邻 Agent 操作。

**把返回指令放进系统提示词。** 这会在继承消息之前加入 child-only 字节。将其追加到初始用户任务，可以保留继承前缀，并让 parent id 紧邻需要它的任务。

**忽略显式 child `toolFilter`。** 结构性返回工具过去会绕过 child allow-list。否决该方案，因为声明的工具限制必须同时决定 schema 可见性与指引；隐藏权限会让面向模型的工具清单失真。

## 后果

- 未请求 persona 或工具过滤时，parent 与可继续 fork child 暴露逐字节相同且顺序一致的工具 schema。
- 继承的 Session 种子位于 child 初始任务及其返回指引之前。
- base 与 headless profile 保持 one-shot fork；选定的 CLI preset 会在没有 child-only 请求头增量的前提下使用可继续 fork。
- child 显式向直接 parent 发送零条或多条消息；最终回答不会被隐式复制。管理器负责的结算通知仍然无条件执行，并且与 Agent 消息分离。
- keyless snapshot 与包测试固定 schema 相等性、继承历史顺序、parent-id 指引，以及通过同一个 `send_message` 操作完成的 child-to-parent 投递。

### 已接受风险

提供方侧前缀复用仍取决于选定的提供方和模型，以及是否不存在显式 persona 或工具过滤差异。harness 证明的是自己组装出的请求头输入相等，而不是提供方的缓存行为。
