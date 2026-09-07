# Agent Note: 环境事实位于可复用提示词指令之后

Status: implemented

[English](2026-09-06-environment-prompt-suffix.md) | 中文

## 问题

本地 Web URL、Harness checkout 路径和会话 cwd 因用户与机器而异。将这些事实放在可复用工具指令之前，会使其余内容相同的提示词在开头附近就出现差异，限制可供同模型缓存复用的前缀。模型名称介绍标识 agent（智能体），可以保留在靠前的位置。

## 决策

[系统提示词注册表](../../../../packages/core/system-prompt/README.zh.md)将固定 Harness 身份保留在最前，并将 `DEPLOYMENT_PERSONA_PREFIX` 保留在 `0`。截至 `STRUCTURED_OUTPUT` 的第一方可复用指令位于环境后缀之前：`HARNESS_SOURCE` 位于 `10000`，`WEB_SURFACE` 位于 `10100`，`DEPLOYMENT_PERSONA_SUFFIX` 位于 `10200`。

全局 system-prompt 配置接受 `personaPrefix` 与 `personaSuffix`，两者均默认为空。[带作用域的 persona 行](../../../../packages/preset/persona/README.zh.md)要求提供 `prefix`，并接受默认为空的 `suffix`。它们通过导出的 `PERSONA_PREFIX_SECTION` 与 `PERSONA_SUFFIX_SECTION` 名称注册 `deployment:persona-prefix` 与 `deployment:persona-suffix`。省略或为空的作用域 `suffix` 会遮蔽掉全局后缀。交付的 Web、headless、SDK、ACP bundle 以及 standard、PTC、Cordis preset 将模型介绍保留在前缀中，仅将 `Your working directory is {{cwd}}.` 放入后缀。这些名称指定位置，而不对文本分类；不添加 persona 解析或 OS 字段。

[提示词变量与工具指导归属记录](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)仍保留 identity-first 的 persona 位置、单一归属规则、严格插值和工具指导职责。

## 曾考虑的替代方案

**将整个 persona 后移。** 这会将模型名称介绍移离开头，却无助于同模型复用。分离 cwd 可以将介绍与可复用指令一起保留。

**仅移动源码路径与 Web URL。** 若 cwd 仍位于靠前的 persona 内，不同工作区之间的可复用前缀仍会被打断。

**从 persona 文本推断环境片段。** 解析部署方撰写的行文会使位置依赖措辞。显式模板让交付组合与自定义部署直接控制位置。

**将这些事实移到 runtime-context 消息。** 这会改变其消息角色和持久化位置，而不只是分离系统段落。

## 后果

字节相同的前缀要求模型介绍、persona 前缀、工具、配置和前置段落文本一致。任意扩展顺序与组装监听器仍决定最终结果；这是一项第一方位置策略，而非通用稳定前缀保证。不测量或承诺提供方共享缓存及命中率提升。

环境与 Web／源码指导位于结构化输出指令之后。`complete: true` persona 仅使用渲染后的前缀并忽略后缀，抑制其他所有系统段落，但不禁用工具 schema 或 runtime context。源码与 Web 事实保留 Harness checkout、会话工作区和当前工作目录之间的区分。

## 测试

[注册表测试](../../../../packages/core/system-prompt/tests/system-prompt.spec.ts)在模型相同、checkout 路径、URL 和 cwd 值变化时比较可复用前缀；同时覆盖严格插值与完整覆盖。[循环测试](../../../../packages/core/agent-loop/tests/loop.spec.ts)固定靠前的模型身份和会话 cwd 插值。[Persona 测试](../../../../packages/preset/persona/tests/persona.spec.ts)覆盖作用域后缀替换、空值遮蔽与完整 persona。[录制的提示词快照](../../../../docs/testing.zh.md)覆盖原生工具与生成 SDK 组合发出的提示词；它们不测量提供方缓存命中。
