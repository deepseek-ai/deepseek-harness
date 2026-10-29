# Agent Note: 委派指导段保留结束本轮说明

Status: implemented

[English](2026-10-21-subagent-end-turn-guidance.md) | 中文

## 问题

委派指导段以 `When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.` 结尾。后来的一次提示词回退把这句和不相关的提示词改动一起删掉了。

这句出现之前，一个长 Session 为了等待 2–9 分钟就结束的 review 子代理，七次 `sleep` 150–240 秒，累计约 25 分钟（#6057）。2026-10-21 的受控探针测量了这句对「子代理启动后模型下一条消息」的影响：`deepseek-v4-flash` 与 `deepseek-v4-pro`，每臂每模型 150 次请求，最小 system prompt，真实 `subagent` 与 `bash` schema，历史以 `started subagent reviewer-1` 结束。

| 组 | sleep 调用 | 任何 bash 调用 | 结束本轮 |
|---|---|---|---|
| 有这句 | 0/300 | 7/300 | 291/300 |
| 无这句 | 29/300 | 120/300 | 179/300 |

分模型差异：flash `0/150` vs `6/150`（p=0.030），pro `0/150` vs `23/150`（p=9.6e-8），双侧 Fisher 精确检验。有这句的一组里剩余 2 次是重新调用 `subagent`，而不是结束本轮。

## 决策

委派段保留结束本轮这句，文本与 #6057 引入的版本逐字一致。结束本轮不会丢失结果：子代理结束后会向父级投递 user-role 通知，通知到达空闲父级会起一次独立的模型请求（[`dsh-subagent`](../../../../packages/subagent/subagent/README.zh.md)）。在子代理继续推进期间，宿主交替等待 `agent.whenIdle()` 与 `waitForChildren(agent)`（[ACP `session.ts`](../../../../packages/acp/acp/src/session.ts)），`dsh-goal-round-driver` 也会等运行中的后代结束再开下一轮 goal。

这句保持为一行字面文本。把 `the next result starts a new turn` 改成 `each result starts a new turn` 会重录 83 个提示词 sidecar，而测不到行为变化。

## 考虑过的替代方案

**只依赖工具描述。** `subagent` 工具描述写明运行时会在子代理结束时通知模型。探针测得没有这句时 sleep 为 29/300，说明工具描述替代不了它。

**把说明移进工具描述。** 这段指导按可见委派工具集合组装并列出工具名，工具描述只描述单个工具。移动这句会改变归属，但不改变它阻止的行为。

**把与这句一起被回退的所有提示词都恢复。** read 指导与 `run_code` 参数顺序是各自有证据的独立决定；本记录只覆盖委派段。

## 验证

- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 对每种可见工具组合断言渲染出的指导段，包含恢复后的这句（9 条断言）。
- 83 个 `snapshots/**/system-prompt*.expected.md` sidecar 带有恢复后的文本，由 `test:snapshot` 通过随附 headless profile 回放。
- 探针是一次性受控测量，未入库；两组只差这一句指导。

## 影响

- 只要存在可见委派工具，每个请求多一句，约 30 token。
- 模型在只剩等待委派结果时结束本轮，不再调用 `bash sleep` 或轮询。
- 后续的提示词精简必须把这句当作承重文本；上面的探针表是保留它的证据。
