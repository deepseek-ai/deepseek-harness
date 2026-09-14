# 长会话浏览器基准

[English](README.md) | 中文

[long-session.bench.ts](long-session.bench.ts) 中必需的 Chromium 工作流测量打开包含 240 个轮次的合成会话、加载所有较早页面、访问 Trajectory，以及在有节奏的流式回复期间输入下一条草稿。随产品维护的 Web scaffold 拥有隔离的主目录、持久化、回放适配器和回环监听器；Chromium 加载构建后的 Web 产物，而非替代开发服务器。

## 运行

`pnpm run test:bench` 先构建 library、worker 和 Web 产物，再串行运行基准清单。产物已构建时，通过 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/long-session-browser` 选择此目录。首次运行前，通过 benchmark workspace 安装 Chromium。

## 测量

三个全新浏览器进程与 scaffold 环境产生原始样本及中位数判定。打开和分页在预期 transcript（文本记录）状态出现且经过两次动画帧后结束；这包含一次渲染机会，而非硬件显示时间戳。分页报告每一页，并对各样本最慢分页时间的中位数执行预算检查。流式报告首次可见回复、受信任的草稿键入、完整回复壁钟时间和 Chromium 主线程任务时间。Enter 从已聚焦的输入框提交；草稿键入保留该焦点，不执行鼠标点击。回复标记查找与输入事件文本观察器仅读取最新 Assistant 步骤，避免重复进行全量历史文本扫描和无障碍扫描。输入事件文本观察器在提交前安装，首个标记可见后立即开始草稿键入，不额外等待输入前动画帧。回复标记在动画帧上采样，要求文本在最新步骤内可见。首次观察在浏览器内记录标记状态与焦点；诊断在键入后取回，不增加输入前的通信往返。诊断还包含首个输入事件的浏览器时钟时间戳与焦点。诊断不会暂停回放；首次观察或输入延迟仍可能导致重叠失败。实际首个输入事件必须观察到未完成的回复；完整回复的测量会在 Host 结算后等待新 turn-tail 渲染完成。测量后，在 DONE 之后发送的受信任按键必须无法通过同一个重叠断言。打开、最慢的较早页面和首次 Trajectory 使用标准托管预期 900/700/500 ms。共享的 1.25× 余量分别产生 1125/875/625 ms 上限；流式终点的额外开销预算不变。强制 GC 后的 heap 与 DOM 数量仅供诊断，不作为泄漏预算。

fixture（测试前置数据）在首条用户消息前保留空 system 头节点，每条用户消息都位于其步骤内。它包含混合语言提示词、正文、推理（reasoning）、20 个围栏代码块和 40 个合成工具结果。每条历史 Assistant 都含紧凑流，由生产 accumulator 从匹配的推理、文本、工具参数、usage 和 finish 分片构建。其内容不来自模型、工具、外部网络、录制会话或私有 Harness 主目录。流式回复以 16 ms 回放间隔发送 120 个文本 delta，经过真实输入框、agent loop（智能体循环）、传输与持久化。

[决策记录](../../.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.zh.md)拥有校准、排除项与替代方案。更大规模的[手动诊断](../../apps/web/tests/complex-history.perf.ts)保持独立。
