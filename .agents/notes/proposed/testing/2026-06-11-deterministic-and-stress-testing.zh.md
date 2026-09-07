# Agent Note: 确定性测试、回放不变式 fixture 与竞态压力测试

Status: proposed

[English](2026-06-11-deterministic-and-stress-testing.md) | 中文

[CI 测试可靠性 Skill](../../../skills/dsh-ci-test-reliability/SKILL.md) 提供当前的测试编写与诊断指引，但没有实现本提案中的 lint 规则、通用回放 fixture 或 nightly stress job。这些机制仍处于提案状态。

## 问题

若干 agent loop（智能体循环）测试通过 `setTimeout(30)` 睡眠来同步——这是一笔不稳定性债务，浪费 agent 的重试周期，还可能掩盖时序 bug。另外，我们的核心架构承诺（任何会话日志回放后都能得到相同的派生历史）目前只在两个测试中断言，但在*所有*测试中断言的成本极低。此外，inbox 唤醒竞态只被手动验证过一次，没有任何机制持续复验。

## 提案

三项措施：

1. **测试中禁止挂钟睡眠。** 将 `setTimeout(N)` 等待替换为事件驱动等待（既有的 `waitForIdle` 模式，扩展为 `waitForStatus`、`waitForEvent(n)`），或在需要测试时间本身时使用 vitest 的 fake timer。通过 lint 规则禁止 `setTimeout`，适用范围是 `packages/*/tests`，白名单辅助模块除外。
2. **通用回放 fixture（测试前置数据）。** 一个共享测试辅助函数包装 agent loop harness，使每个测试结束后，agent 的会话日志被回放到一个全新的 Session 中，并自动断言 `deriveMessages()` 相等。这样该不变式在每次 CI 运行中会被套件产生的所有场景检查数百次，而非仅两次。
3. **夜间竞态压力测试。** 一个 CI job 以 `vitest --repeat=200`（加 `--shuffle`）运行 agent-loop 和 inbox 套件，以暴露调度依赖的失败；发现的任何不稳定现象都视为需要修复的 bug，绝不靠重试掩盖。

## 计划

措施 1 和 2 一起落地（它们改动相同的辅助模块）；在套件消除所有睡眠后再添加夜间 job，以确保重复运行速度快。

## 验收标准

- 不再使用 `setTimeout`；lint 规则在 `packages/*/tests` 中强制执行，白名单辅助模块除外。
- 共享 harness 将每个测试的会话日志回放到全新的 `Session` 中，并自动断言 `deriveMessages()` 相等，覆盖整个套件。
- 夜间 job 以 `--repeat` 和 `--shuffle` 运行 agent-loop 和 inbox 套件；发现的不稳定现象一律按 bug 分诊，绝不通过重试消除。

## 风险

Fake timer 与 agent loop 中的 Promise 调度存在微妙交互——优先使用事件驱动等待；仅在测试 timer 服务行为本身时才使用 fake timer。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
