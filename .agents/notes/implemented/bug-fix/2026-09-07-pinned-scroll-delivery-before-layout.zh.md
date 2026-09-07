# Agent Note: 在布局变化前处理贴底滚动事件

Status: implemented

[English](2026-09-07-pinned-scroll-delivery-before-layout.md) | 中文

## Problem

延迟的滚动采样会比较来自不同布局的位置。Chat 贴底时，输入框或 transcript（文本记录）收缩可能改变浏览器底部位置；随后的增长又可能在 `scrollend` 或采样定时器触发前改变浏览器位置。在此期间推迟跟随会使已观察顶部位置记录过期，把浏览器布局移动误判为读者输入，在没有读者操作时关闭跟随。

## Decision

[ChatView](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) 使用现有的已观察顶部位置比较，通过同一个清除待处理工作的采样操作，同步采样非读者引起的贴底滚动事件。这会在后续增长前恢复布局跟随。真实读者移动即使位于跟随阈值内，也保持待处理直到现有周期或 `scrollend`：增长不能在小幅操作累积为离底滚动前将其抵消。立即执行的贴底采样只读取滚动指标，不读取语义行几何。

## Alternatives considered

**延迟所有事件。** 合并采样减少阅读历史时的几何计算，但贴底浏览器位置及其底部必须在同一布局中完成归因。过期比较关闭跟随后，延长超时或重试都无法恢复归属。

**同步采样所有事件。** 这能恢复归因，却也会在离底读者连续滚动时重复测量语义锚点和阅读线。只有贴底归属需要立即处理。

## Consequences

贴底事件会立即读取滚动指标。历史阅读保留有界采样节奏，显式回到底部的滚动事件会清除任何待处理的离底采样。[聚焦测试](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) 覆盖 scrollend 前的收缩与增长、无需行测量的观察器增长、存在待处理采样时重新贴底、定时器与 scrollend 采样，以及卸载取消。[无密钥浏览器场景](../../../../apps/web/tests/chat-scroll-contract.e2e.ts) 覆盖长 transcript 中贴底发送、真实离底输入、流式输出与工具详情展开。
