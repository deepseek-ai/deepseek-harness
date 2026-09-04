# Agent Note: 嵌套 agent 的逐会话快照回放

Status: implemented

[English](2026-06-22-subagent-snapshot-replay.md) | 中文

## 问题

快照层（`pnpm run test:snapshot`）会启动真实 `acp-agent` 子进程，通过 [`dsh-llm-replay`](../../../../packages/test-support/llm-replay) 回放已记录会话，并将规范化后的自动化协议输出 + 重新持久化的会话日志与已提交预期输出进行 diff。大多数场景通过这条真实进程边界测试组装后的后端行为。

该层最初为每个进程只有一个会话而构建，这一假设硬编码在两处：

- **`dsh-llm-replay` 没有做任何键控。** 它用一个全局游标，将第 N 次 `llm/stream` 调用对应到单一录制序列的第 N 条。当父 agent（智能体）和一个进程内 subagent 在同一个上下文上同时流式输出时，调用交错，单一游标会把子 agent 的脚本发给父 agent（反之亦然）。
- **harness 只收集一份日志。** `findSessionLog` 遍历 sessions 根目录，返回找到的第一个 `.jsonl`。subagent 作为第二个 `Session` 运行并拥有自己的日志，因此子 agent 的 transcript（文本记录）被静默丢弃。

这就是 [subagent seam Agent Note](../feature/2026-06-21-subagent-capability-seam.zh.md) 中通过 `TODO(subagent-snapshots)` 推迟的工作：进程内后端落地时已有单元 + e2e 覆盖，但在这套基础设施落地前，完整 transcript 快照层无法表达嵌套 agent 形状。

## 决策

回放按**调用方会话**键控，harness 收集**所有**会话日志。

### 1. 调用方会话 id 附着在模型请求上

`GenerateOptions` 新增可选字段 `sessionId`，在请求组装时从 `agent.session.id` 赋值。适配器忽略它；`llm/stream` 监听器用它按发起会话路由。其类型为 `Branded<'SessionId'>`（来自 `dsh-brand`）而非 `dsh-session` 的 `SessionId`，因为后者所在包导入了 `dsh-llm` 的 `Message`，反向导入会形成循环。两个类型等价，因此会话 id 赋值无需类型转换。将 brand 移到一个专用 ids 包属于独立工作，因为它会影响所有 id 导入。

### 2. 回放按首次调用顺序将活跃会话绑定到录制脚本

嵌套场景录制多个角色：parent 使用 `session[.vN].jsonl`，每个 subagent child 使用 `session.<ordinal>[.vN].jsonl`。V0 省略 `.v0`，正 generation 使用小写 `.vN`，harness 为每个角色选择数值最高的文件。`dsh-llm-replay` 加载这个选定集合，并为每个录制 Session 派生一份脚本。Primary 脚本始终先绑定；child 脚本按 header `createdAt` 绑定，timestamp 相同时由 recorded id 决胜。持久化发现另外按 `createdAt` 分配 child fixture ordinal。

活跃会话 id 每次运行都是全新随机值，永远不等于录制时的 id，因此活跃会话无法通过 id 相等绑定到脚本。取而代之的是**首次调用顺序**绑定：第一个发起任何模型调用的活跃会话认领第一份有序脚本（即父会话：`createdAt` 最早，且必然最先流式输出，因为它必须先运行一个轮次才能委派），下一个新活跃会话认领下一份脚本，依此类推。此后每个会话独立推进自己的游标。

这种方式按谁在调用键控，而非按全局调用顺序。因此即使 subagent 将来并发或在后台运行（全局游标会导致交错），它仍然正确。不携带 `sessionId` 的调用（直接在单元测试中调用 `stream()`）被视为一个匿名会话、绑定到主脚本，因此单会话路径与旧行为逐字节一致。活跃会话数多于录制脚本数时会明确报错（出现了未录制的 subagent），绝不会静默错误路由。

子 fixture（测试前置数据）按 `createdAt` 排序，在兄弟会话严格顺序执行时与调用顺序一致。id 决胜规则仅用于让极端情况下的时间戳冲突获得确定顺序。并发或后台子会话必须引入显式的首次调用序号，而非依赖时间戳。

## 曾考虑的替代方案

曾考虑但否决的方案是：**将父子日志按调用顺序合并**为一份全局脚本（仅在进程内 subagent 执行严格嵌套——父 agent 阻塞等待子 agent——时才正确）。对同步执行模型而言更简单，但将「父阻塞于子」这一不变式固化了进去；未来若引入后台/并发 subagent 就会失效。逐会话键控则不会。

### 3. harness 收集所有日志，主会话优先

`harvestSessionLogs` 会在每个持久化 Session 目录下递归选择数值最高的规范 generation，解析各自 header，并按 primary 优先排序：顶层 Session（无 `parentSession`）在前，各 child 按 `createdAt` 升序排列。`RunResult.sessionLogs` 包含多份日志；record 与 refresh 会把每份当前输出写入 `session[.vN].jsonl` 或 `session.<ordinal>[.vN].jsonl`，为仍产生的角色保留旧 generation，并把选定的最高 replay 输入与新鲜当前输出做 diff。normalizer 已支持多个 Session id 并会折叠任何游离 UUID，因此无需修改 normalizer。

### 4. 场景

新增两个嵌套场景，均对真实 API 录制：

- **`subagent-spawn-in-process`**：父 agent 通过 `subagent` 工具将一个子任务委派给一个新 spawn 的子 agent（2 个会话）。
- **`subagent-multi`**：父 agent 委派两个子任务，各自交给自己的 spawn 子 agent（3 个会话），以三份独立的逐会话脚本和同一父 agent 下两个子会话的 `createdAt` 排序来压测逐会话键控。

两者均在默认门禁中以 keyless 方式回放。

## 后果

- `TODO(subagent-snapshots)` 延期项已解决：嵌套 agent 的 transcript 现在是快照层的一等形态。
- `GenerateOptions.sessionId` 是一个小而诚实的 core API 新增，在回放之外同样有用（遥测、请求路由）。
- `subagent` 工具绑定到单一 provider，因此 `subagent-multi` 中两个 child 都是 spawn。键控按 Session 而非 backend 路由，因此对 fork 同样正确。脚本*派生*需要 fork cut，因为 fork 子 Session log 以 seeded parent prefix 开头，其中包含 parent Assistant settlement；从完整 log 派生会把 parent response 当作 child response replay。持久 seed boundary 会关闭该缺口——见[持久化 seed 边界以确保 fork 子 Session replay 正确路由](2026-06-22-fork-child-replay-seed-boundary.zh.md)——录制的 fork 与混合 spawn+fork 场景通过一份 transcript 验证两种 transport（见[记录 fork 与混合 spawn+fork snapshot 场景](../../archived/testing/2026-06-22-fork-snapshot-scenarios.md)）。
- 进程外（ACP（Agent Client Protocol））subagent 是完全不同的回放形态（每个子 agent 是自己的进程、有自己的回放），作为 `TODO(acp-subagent-replay)` 记录在 `subagent-acp` 中。
