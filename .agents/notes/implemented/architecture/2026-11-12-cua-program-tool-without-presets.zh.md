# Agent Note: 未组合 preset 的 Agent 使用 CUA 程序工具

Status: implemented

[English](2026-11-12-cua-program-tool-without-presets.md) | 中文

## 问题

SDK、headless 和 ACP 应用创建 Agent 时不组合 Agent preset，它们的 profile 也不挂载 preset 注册表。以 preset ID 配置的原生 CUA 提供方不为这些 Agent 注册任何工具，因此其默认配置和 Computer Use 组合包在这些 Host 上不起作用。`agentPreset: false` 只提供原始 `cua` 工具。模型直接调用普通工具的 Host 没有任何配置可以获得 `cua_run_code`。

## 决策

`agentPreset` 为 preset ID 时，只有使用该 preset 的 Agent 获得原始 `cua`。其他 Agent 都获得 `cua_run_code`，包括未组合 preset 的 Agent，以及没有 preset 注册表的组合中的全部 Agent。注册表是提供方的可选依赖：注册表加载或卸载时，提供方重新计算每个存活 Agent 的工具形态；没有注册表时，任何 Agent 都不算使用所配置的 preset。`agentPreset: false` 仍全局注册原始 `cua`，并且不创建程序运行时。

这部分取代 [PTC preset 之外的 CUA 程序](2026-11-09-cua-program-tool.zh.md)中未组合 preset 的 Agent 不获得任何工具的决定。原记录继续负责程序工具的运行时、初始化，以及每个 Agent 只使用一种工具形态的选择。本决策还改变了[Host 平面说明](2026-08-10-host-plane-ownership-after-presets.zh.md)记录的一项后果：此前未加入 preset 的 Agent 不获得任何工具。该记录继续负责入口显式让 Agent 加入，以及没有检查会因为 Agent 未加入 preset 而拒绝它这两条规则。

## 考虑过的替代方案

**未组合 preset 的 Agent 仍不获得工具**保留了原先的默认行为。它在这些 Host 上的唯一效果是启用 Computer Use 后没有任何变化，也没有任何提示。

**在提供方配置中增加字段，为这些 Agent 选择工具形态**会让默认配置仍然不起作用，要求每个这类 Host 设置两个字段，并增加一种与 preset ID 并用时无效的组合。

**在 SDK server 中组合 preset** 只覆盖三个 Host 中的一个，需要修改非实验性的包，并要求每个部署声明一个 ID 与 `agentPreset` 不同的空 preset。

**按工具执行器选择形态**需要执行器接口标识程序执行器，而该接口没有这项信息。

**程序服务不可用时照常创建 Agent、不注册该工具并记录警告**会在本决策所服务的 Host 上掩盖失败：SDK 或 headless 的调用方会得到一次没有 Computer Use 的完整运行，并且收不到任何错误。提供方因此沿用它对使用其他 preset 的 Agent 采用的规则：创建时等待专用运行时，在该运行时或 `workingDirectory` 服务不可用时拒绝创建，例如运行时设置无效，或组合中没有 `workingDirectory`。这与[Host 平面说明](2026-08-10-host-plane-ownership-after-presets.zh.md)否决的检查不同。那项检查会拒绝所有未加入 preset 的 Agent，而 SDK server、ACP 桥和 headless bundle 创建的 Agent 全部如此。提供方只在无法提供其配置所选的工具时拒绝创建，并且 `agentPreset: false` 可以去掉对程序运行时的依赖。

## 后果

不组合 preset 的 Host 使用默认配置即可获得 `cua_run_code`；Web 和 Desktop 会话都会组合 preset，不受影响。在不组合 preset 的 Host 上，创建 Agent 时会等待专用程序运行时，其所需服务不可用时创建失败。这类 Host 挂载 PTC 执行器时，`run_code` 内会出现 `tools.cua_run_code`，除非提供方设置 `agentPreset: false`。迁移步骤见[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/cua-agents-without-preset/guide.zh.md)。单元测试覆盖有注册表和没有注册表的组合，以及注册表的加载与卸载；已记录的 SDK 会话和 headless 会话覆盖组装后的请求和程序执行，其中 headless 会话经由 PTC 工具执行器。
