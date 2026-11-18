# Agent Note: PTC preset 之外的 CUA 程序

Status: implemented

[English](2026-11-09-cua-program-tool.md) | 中文

## 问题

Computer Use 需要在标准及其他 preset 中复用应用和窗口对象，同时保留普通工具的调用方式，也不要求用户更改 profile 的 PTC 运行时。实验性 CUA 包不能出现在随产品提供的 preset 定义中。程序派发必须保留与 PTC 相同的权限检查、取消、嵌套日志和截图行为。

## 决策

CUA 保留 `agentPreset: ptc`，用默认选择器指定获得原始 `cua` 工具的 preset。其他已组合的 preset 获得 `cua_run_code`。未组合 preset 的 agent（智能体）也获得该工具；[未组合 preset 的 Agent 使用 CUA 程序工具](2026-11-12-cua-program-tool-without-presets.zh.md)取代了原先不为它们注册工具的决定。`agentPreset: false` 保留全局原始工具注册。基础注册的所有者通过 Agent 作用域管理注册和销毁，因此启停提供方会影响已有和后续 Agent，无需修改 preset。原始工具的注册只依赖基础 CUA 服务和 preset 选择。私有程序工具的提供方按定义对象的身份发布和撤回其定义；私有依赖缺失或启动失败时，原始工具和提示词仍然可用。

`cua_run_code` 将共享[程序工具工厂](../../../../packages/core/tool-executor-ptc/README.zh.md)与 CUA 提供方持有的单个隔离 Node `persistent-in-memory` 运行时组合。Agent 的 `stateOwner` 身份选择各自独立的保留进程。它只绑定私有 `tools.cua` 定义；模型直接调用其他普通会话工具。嵌套 CUA 操作保留工具策略、guard、派发事件和图像接纳。程序通过 `inspect(...values)` 选择文字和截图，遵循[显式输出决策](2026-11-09-explicit-ptc-output.zh.md)。任一程序工具结束时，提供方都会释放该程序仍按住的键。提供方卸载时，先等待自己持有的 CUA 程序结束再清理原生资源；释放其他 PTC 程序持有的输入时，不等待这些程序中的其他工作。状态保存在内存中，独立于 profile 的 PTC 状态，随所属 Agent 或提供方释放。

CUA 在隔离运行时首次接纳运行前，通过 `registerEnvironmentInitializer` 注册一段源码。每个新环境安装本次绑定后执行该程序一次，包括临时提权环境。子进程等待 Host 确认后才开始执行模型代码。初始化与首次运行共享时间和输出预算；失败会丢弃环境并阻止模型代码执行，但不回滚外部效果。独立求值保留模型源码位置。初始化程序所属的作用域只依赖运行时，因此程序工具的依赖重载时仍保留这项注册。PTC 保留显式 bridge 初始化。

这部分取代[原生 CUA 对象](2026-09-17-experimental-cua-object-api.zh.md)中不提供 CUA 程序入口的决定。原记录继续负责对象 API 独立于求值器，以及共享对象与原生操作之间的职责划分。共享 Node 提供方负责求值，CUA 提供受限的绑定和初始化。[可选组合包决策](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)继续负责分发和启用方式。

## 考虑过的替代方案

**CUA 专用求值器**会重复实现执行生命周期策略。复用 PTC 工厂和运行时，使取消、限制、沙箱和结果处理继续由现有实现负责。

**profile 的共享运行时**会使 CUA 状态依赖无关的 PTC 和工作流设置。其默认逐次调用模式无法保留对象。独立的 CUA 运行时保留 profile 选定的执行模式。

**全局注册两种工具形态**会在 PTC 程序中暴露另一个程序执行器，并向其他 preset 暴露原始 CUA 调用。按 Agent 选择一种形态，可以保留各模式预期的工具列表。在 `cua_run_code` 内绑定所有会话工具，会重复普通的直接调用及其声明。

**把初始化拼到模型代码前**会偏移源码位置。通过单独的工具调用执行初始化无法适用于临时提权环境，因为下次调用会启动另一个进程。首次运行时执行中的独立程序同时支持保留环境和临时环境。每次提交程序都传入初始化，会使环境准备依赖工具请求，并在已有环境中重复执行；注册使准备和清理继续由运行时所有者负责。

## 后果

CUA 不增加 preset 列表，也不向内置 preset 添加依赖。工具形态按 preset ID 选择；自定义 PTC preset 必须与 `agentPreset` 匹配。PTC 与 CUA 共享公开工厂；CUA 拥有运行时初始化程序的注册，注销前会等待自己的程序工具执行结束。旧版自定义 Node bootstrap 需要匹配协议版本，详见[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.1/ptc-bootstrap-protocol/guide.zh.md)。

私有绑定限制可调用的 Harness 工具，不限制 Node API。文件与进程访问仍遵循所选沙箱策略。保留变量不会独占应用，也不能跨进程丢失保留；调用方应重建对象并观察状态后再继续。组合测试和已记录会话测试覆盖工具选择、自动初始化、状态保留、嵌套输出及移除；平台输入行为仍由原生 fixture（测试前置数据）负责验证。
