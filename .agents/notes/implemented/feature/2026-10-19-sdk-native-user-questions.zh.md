# Agent Note: SDK 原生用户问答

Status: implemented

[English](2026-10-19-sdk-native-user-questions.md) | 中文

## 问题

SDK 可以在没有 Web GUI 时暴露共享的 `ask_user_question` 工具，但进程外宿主无法通过 SDK 回答原生用户问答事件。仅发布工具会使调用缺少回答方。SDK 必须承载交互，应用则自行选择用户界面或模拟用户策略。

## 决策

TypeScript 与 Python 客户端接收问答回调，并在初始化时声明。SDK server 仅为其确切拥有的根 Agent，把现有用户问答 seam 适配为双向 RPC。未声明能力的客户端保留原生进程内回答方。工具定义以及服务对存活根 Agent 和委派关系的检查仍与桌面端组合共享。

问题标识独立于 JSON-RPC 帧，使取消能够定位待决的宿主工作。运行时校验完整答案批次，在工具或服务器停止时中止待决请求，并忽略晚到响应。宿主拥有答案收集过程；SDK 不选择答案，也不把缺失输入当作批准。[协议参考](../../../../packages/sdk/protocol/README.zh.md#native-user-questions)拥有具体协议说明。

## 影响

此流程不要求 GUI 或运行时补丁模块。宿主可以用同一接口接入终端、浏览器或模拟用户。Python SDK 在读取线程之外执行回调，以保留同步 API；回调必须响应取消并释放自己的资源。晚到回调无法向后续新运行时进程发送结果。问题等待仅属于当前进程；已完成工具结果仍通过普通 Session 路径持久化。

Web Session controller 不能充当 SDK 的交互提供方。提醒恢复使用 SDK 自身的 Session 所有者和初始化模型选项，不通过 GUI 控制器争用第二个写入 handle。

## 已考虑的替代方案

要求 Web GUI 或挂载其控制器，会将 headless 执行与另一个生命周期所有者耦合。要求各宿主注入运行时补丁，会在受维护的 SDK 外重复实现传输适配。移除共享问答工具只会减少模型可用能力，无法提供缺失的回答通道。

## 验证

服务器测试覆盖所有权、原生回退、答案校验、取消和传输失败。客户端测试覆盖并发双向传输和取消，包括显式启动和直接调用 `initialize()` 两条路径的回调声明与答案投递。初始化在构造握手能力之前启动运行时，使两条入口均声明已安装的回调。Python 测试还覆盖回调内再次请求，以及进程替换后的晚到回调。真实发行 profile 测试在标准模式和 PTC 模式调用内建问答，并在宿主回答期间关闭运行时。[服务器测试](../../../../packages/sdk/server/tests/user-questions.spec.ts)、[客户端测试](../../../../packages/sdk/client/tests/user-questions.spec.ts)、[Python 测试](../../../../python/sdk/tests/test_user_questions.py)和 [profile 测试](../../../../apps/cli/tests/profiles/sdk/user-questions.e2e.ts)保留这些依据。
