# Agent Note: headless 将提供方推理流式写入 stderr

Status: implemented
Archived: 2026-09-04

[English](2026-08-21-headless-reasoning-progress.md) | 中文

## 问题

一次性 headless runner 会等待 Agent（智能体）完全停稳，再打印最终 Assistant 文本。具备推理能力的 provider 会通过实时 `agent/assistant-stream` chunk frame 与最终持久 settlement 暴露 reasoning，但如果 runner 只观察已结算历史，耗时较长的 reasoning response 会让终端始终静默。最终答案必须继续作为 stdout 中唯一 payload，使命令替换和其他消费方保持稳定结果通道。

此前的[直接使用核心服务入口决策](../architecture/2026-08-09-headless-direct-core-entry-point.zh.md)要求每次成功运行都保持 stderr 为空。该条款会阻止实时推理进度，因此由本 Agent Note 取代；其中关于传输、持久性与完成状态的其他决策保持不变。

## 决策

`headless-runner` 在启动工作完全停稳后、提交任务前，为其创建的精确 Agent 观察 `agent/assistant-stream`。自身持有的区间以 `turn/start` 打开后，每个非空 `reasoning-delta` chunk frame 都会立即写入 stderr。一段连续 reasoning 以独占一行的 `dsh: reasoning:` 开始；各 delta 保持 provider 顺序，不添加 token 边界装饰。Reasoning block boundary 与 usage metadata 会保持该段打开；之后出现非 reasoning block 或 output delta、stream end、新 turn 或 listener dispose 时，如果 provider 没有输出末尾换行，runner 会用一个换行终止该段。

该输出是进程本地 Assistant stream 的瞬态投影。runner 仍从 flush 后的持久 Session settlement 而非进度呈现状态推导最终文本与退出状态。SDK 投影不公开 live frame。

推理进度不按 TTY 启用，也没有单独 flag。重定向的 stderr 流与监督进程会收到和已连接终端相同的提供方报告内容。没有推理内容的成功运行仍不会写入 stderr；终止态模型错误与驱动器错误继续在任何已打开推理段终止后输出既有的 `dsh:` 诊断。

## 验证

包测试在 reasoning frame 后保持 Agent 活跃，并在 idle 前观察 stderr；测试同时固定由 provider 终止和未终止的 reasoning 段换行归属，以及 terminal error。产品自有期望通过包含 reasoning 与工具调用的 turn 驱动随附 headless profile，并固定 stderr 与持久 Session。录制 Session replay 通过展开嵌入式 Assistant stream 重建预期 stderr，在 text 与 tool-call output 处关闭 reasoning 段，并在 record mode 下于 fixture path tokenization 前使用原始 run log。构建后二进制 acceptance 通过原生 DeepSeek SSE adapter 发送 `reasoning_content`，要求 reasoning 出现在 stderr，同时 stdout 仍只包含最终答案。

## 考虑过的替代方案

**完全停稳后再输出推理。** 从持久化日志折叠推理能够保留内容，但在导致本功能产生的长时间运行区间内，终端仍会保持静默。

**包装 LLM stream。** 截取 `ctx.llm.stream()` 会把呈现职责放入请求路径，并重复处理 agent loop 已发布的 scoped frame。

**打印 spinner 或周期性心跳。** 定时器报告的是进程存活状态，而不是提供方进度；它还会新增间隔策略，并继续隐藏提供方已经给出的推理。首个推理分片前的时间仍保持静默；如果提供方会缓冲首个 token，可以另行处理。

**仅在 TTY 或显式 flag 下启用输出。** CI 与监督进程中的 headless 运行需要相同的进度信号，而隐式依赖 TTY 会让重定向运行与交互式运行产生差异。不需要推理日志的调用方可以重定向 stderr。

## 后果

具备推理能力的成功运行会把提供方报告的内容写入 stderr，因此日志收集器可能保留明显更多且可能敏感的模型输出。stdout 仍只包含一个最终 assistant 结果，没有推理内容的成功运行保持 stderr 为空，错误继续与推理内容分行，并且本决策不引入新配置或持久化格式。提供方发出首个非空推理分片前保持静默，这是明确的限制。
