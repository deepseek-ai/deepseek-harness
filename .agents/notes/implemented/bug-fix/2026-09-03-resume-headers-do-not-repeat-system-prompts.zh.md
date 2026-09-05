# Agent Note: Resume header 不重复系统提示词

Status: implemented

[English](2026-09-03-resume-headers-do-not-repeat-system-prompts.md) | 中文

## 问题

fork Session 会把源会话历史复制到子会话。即使 system 字段与前一条被复制的 header 完全相同，子会话的第一个模型请求仍会记录一条 reason 为 `resume` 的 `request/header`。Chat 把每条 resume header 都视作新的展示点，因此继续 fork 会显示第二行`系统提示词`，让人误以为系统提示词被注入了两次。提供方请求实际仍只携带一次 system 字段；重复仅存在于 Chat 展示中。

## 决策

持久化 resume header 记录精确重建 Session 所需的请求边界。Chat 会把完整 header 与前一条已加载 Request Prompt 比较，只在初始请求、显式消息序列起点或真实 system 字段变化时显示非空系统提示词。内容未变的 resume 不创建可见的重复行。

部分历史窗口可能以非初始 header 开头，因缺少前序 header 而无法比较。Chat 会保守渲染该系统提示词。如果 prepend 随后补入相同的前序 header，既有 request-prompt Node 会转为隐藏而不是被撤回；其 key 和页面生命周期内的 anchor 保持稳定。不同的 system 字段仍然可见。

Trajectory 会展示每一条请求 header 及其变化分类。Chat 展示不会改变提供方请求、Session event 或重建行为。

## 考虑过的替代方案

**从 Session log 省略未变化的 resume header。** 否决：resume 是真实的请求边界，移除后精确重建将依赖持久日志未记录的进程历史。

**只对 fork Session 做特殊处理。** 否决：普通进程恢复具有相同的展示语义，请求 header 已经包含可直接比较的 system 字段。

**把重复行保留为生命周期标记。** 否决：`系统提示词`描述模型可见的请求内容，用它标记 loop 重启会错误暗示再次注入提示词。请求生命周期证据仍可在 Trajectory 中查看。

## 后果

继续 fork 或在 system 字段未变时恢复进程，当前消息序列只保留一行可见的`系统提示词`。显式序列起点与真实 system 变化仍会重复该行。部分窗口起初可以显示保守行，并在更早历史加载后将其隐藏，同时保留同一个已物化 Node。

单元回归覆盖初始请求、显式序列、未变化 resume、system 变化与 prepend 场景。Web 录制会话场景包含一条未变化的 resume header，并断言稳定后的 Chat 只渲染一个`系统提示词`控件。
