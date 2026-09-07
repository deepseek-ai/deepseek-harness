# Agent Note: 对协议形态代码进行基于属性的测试

Status: implemented
Archived: 2026-09-04

[English](2026-06-11-property-based-testing.md) | 中文

> 属性测试套件首次运行即发现了 BlockAssembler 重复 `block-end` 的真实 bug。

## 问题

基于示例的测试只能固定我们想到的用例。harness 的核心是协议形态的代码：分片流、事件日志、schema 转换、收件箱调度。这些场景的输入空间具有组合性，有趣的 bug 藏在没人写过示例的交错序列中。佐证：一个块组装的排序 bug 曾在 happy path 100% 行覆盖率下存活。逐文件 100% 覆盖率证明每一行都跑过了，但不能证明每种交错都是正确的。

## 决策

每个协议形态的包各有一个由 `fast-check`（根 devDependency）驱动的 `tests/properties.spec.ts`。生成器调优为*逼真但对抗性*的输入（而非均匀噪声），`numRuns` 控制在本地套件总耗时远低于约 10 秒。失败时打印可复现的 seed。（以 100 倍迭代运行的夜间 CI job 未交付——属性测试套件仅在常规的 `push`/`pull_request` CI 中运行；定时高迭代 job 仍属可能的后续工作。）

- **dsh-llm / BlockAssembler：** 任意分片流（合法 + 畸形：重复索引、滞后分片、缺少 block-start）。不变式：`blocks()` 计数 ≤ 已见到的不同索引数；重组幂等（`blocks()` 在重复调用间稳定，且 `message().content` 与之一致）；`blocks()` 从不抛异常且仅产出合法的内容块标签；`finish` 反映最后一个 `finish` 分片，无此类分片时默认为 `{kind:'stop'}`。
- **dsh-session：** 任意事件日志。不变式：`deriveMessages` 确定性；从 seed 回放结果一致；seq 严格单调递增；非消息事件不影响推导出的历史；推导出的内容与日志解耦。
- **dsh-tools：** 任意 `ParameterSchemaSpec`。不变式：JSON Schema 的 `required` 等于每一层 `required:true` 的键集；转换对合法声明而言是全函数；**并且与[运行时参数校验](../architecture/2026-06-11-runtime-arg-validation.zh.md)组合验证**——满足 spec 的生成参数通过 `validateArgs`，而定向破坏（删除必填键、顶层非对象）被拒绝。聚焦用例覆盖每种根值类型、恰好一项匹配中的分支重叠与无匹配、显式开放性、原始默认值以及有损 JSON。这封堵了编译器、validator 与 `InferArgs` 之间的漂移风险。
- **dsh-agent-loop：** 任意发送调度，对接一个永不耗尽的适配器，通过 `agent/status` settle 信号驱动（无挂钟 sleep）。不变式：无消息丢失；轮次编号严格递增；状态转换保持在合法状态机上。

## 后果

- 生成器质量是价值杠杆——生成器偏向小索引池和短字符串，使碰撞与交错频繁发生。
- **它已经带来回报：** BlockAssembler 流发现了一个真实 bug——同一索引处重复的 `block-end` 会改写已经完成的块。现已修复（首次关闭优先，与现有迟到项规则一致），并加入专用回归测试。
- 属性测试因超时而 flake 是一个发现，不应通过重试消除。agent loop（智能体循环）的属性测试在设计上是确定性的（通过 `agent/status` settle），因此挂起即为真实缺陷。
- 属性测试是对示例测试的补充而非替代；示例测试固定特定分支，服务于 100% 覆盖率门禁。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
