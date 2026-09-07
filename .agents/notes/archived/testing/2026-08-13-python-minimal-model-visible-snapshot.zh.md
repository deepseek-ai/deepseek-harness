# Agent Note: Python 极简组合的模型可见快照

Status: implemented
Archived: 2026-09-04

[English](2026-08-13-python-minimal-model-visible-snapshot.md) | 中文

## 问题

Python 通道需要精确记录独立极简 profile 实际展示给模型的内容。功能性工具断言可以证明执行，但无法发现新增系统分段、工具描述或 user 角色上下文消息；而进阶可执行文件快照会把每个请求头中已组装的系统提示词换成占位符，并把每个工具 schema 换成其名称。

## 决策

[打包运行时冒烟测试](../../../../scripts/smoke-python-runtime.py)的 `sdk-minimal` 场景会启动随附 profile，并录制 `scripts/snapshots/python-sdk-single-exe/minimal/model-visible.json`：对该回合的每个模型请求，逐字记录对外公布的工具 schema 与消息列表。system 与 user 消息保留全文，仅将场景的临时目录替换为占位符；assistant 与 tool 消息只保留调用标识，因为它们的 PTY 与文件系统文本在各回放平台上并不相同。该 profile 省略动态运行时上下文，因此它发出的每条消息都会参与比对。

极简场景的工具与系统提示词由快照拥有，而不是由 mock 模型内联断言；快照会给出其完整差异。快照比对以目录与文件集合为参数，因此 `minimal` 与 `advanced` 两份期望输出共用一套实现，且 `--update-snapshots` 接受 `sdk-minimal`。

## 曾考虑的替代方案

**像进阶场景那样对极简会话日志做快照。** 极简回合驱动真实 PTY 与编辑器，持久化的工具结果带有平台相关文本。期望输出会因与模型可见组装无关的原因变红；而把这些文本归一化掉之后，日志所承载的内容也就所剩无几。

**扩展 mock 模型中的内联断言。** 每新增一项模型可见贡献都要再手写一条期望，且失败只会指出一处不匹配而非整个面。工具描述还会从组合复制进脚本，形成重复。

**依赖 TypeScript SDK 快照。** 其 `persistent-tools` 场景通过重放模型响应与 source 或 `lib` 运行时固定一套相似的双工具组合，且位于另一个必需任务中。它无法体现已部署可执行文件的随附 profile 为 Python 调用方组装出什么。

## 后果

极简组合模型可见面的改动——系统分段、工具、工具描述或新增的 user 消息——现在会让 `python-runtime` 带着精确差异失败；要让它落地，就必须重新运行 `--scenario sdk-minimal --update-snapshots` 并审阅该差异。极简组合的工具描述由此成为经过审阅的期望输出。

assistant 与 tool 消息文本不参与比对。持久 shell 状态、编辑器输出与最终响应仍由该场景自身的断言拥有；快照负责该 profile 发出的每条模型可见消息。

[AGENTS.md](../../../../AGENTS.md) 与[测试政策](../../../../docs/testing.zh.md)现已点明两个 SDK 都是 agent loop、会话生命周期与 `SessionEventMap` 的独立投影，因此改动其中任何一项都要连带更新两侧的期望输出，而不只是贡献者恰好会运行的那一侧。
