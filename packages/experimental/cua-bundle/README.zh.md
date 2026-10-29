---
description: "开启可选 macOS Computer Use 及权限页面。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-bundle

[English](README.md) | 中文

## 概述

从插件页为已有和新建 PTC 会话开启 macOS Computer Use。Windows 支持正在开发中。本组合包暂放在 `experimental`，待 Windows 支持完成后迁回 `computer-use` 组。默认关闭，启用或单独安装前不在默认插件列表中显示；关闭时不准备本机组件、不注册 CUA 工具或添加其模型指引。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 macOS Desktop 的“插件 → 添加插件”中输入 `@deepseek-ai/dsh-cua-bundle`，点击“安装”，再点击“立即启用”。DSH 将与当前运行时版本匹配的官方插件安装到 profile。发布包包含已签名和公证的 helper，用户无需编译工具。源码 Web 和开发 Desktop 链接工作区组合包，启用时准备临时签名的 helper。打开 Computer Use 详情，按需设置 PTC，并为 `DSH Computer Use.app` 授予辅助功能和屏幕录制权限。已安装的组合包关闭后仍可管理。源码 Web 在仓库根目录运行以下命令：

```sh
pnpm run build
pnpm dsh web
```

源码 Desktop 的启动方式和独立开发配置档见[桌面开发说明](../../../apps/desktop/README.zh.md)。需要使用 Computer Use 的配置档分别开启该功能。

开关将组合包选择保存到 profile 的 `package.json`。Computer Use 仅安装在 PTC 会话中。通过「添加插件」、可见卡片或详情页启用时，系统权限未就绪会显示设置引导。详情页提供“设为 PTC”按钮来修改新会话默认模式，已有会话保留原 preset。开关保持 PTC 执行方式和其他设置不变。详情页的“设为持久化”按钮单独开启 PTC 跨调用的内存状态保留，作用范围和重载行为见[权限页面](../cua/README.zh.md)。提供方加载时准备本机组件，已有与源码摘要匹配的可执行文件时直接复用。

关闭会卸载提供方，并从其 Agent 作用域中撤回 CUA 工具。执行器配置、新会话默认值和已保存的授权保留。

Computer Use 仅支持 macOS DSH Host。原生提供方是仅在 macOS 安装的可选依赖，组合包和共享库均按需安装。其他 Host 默认不在插件列表和模型推荐中展示此组合包，并在保存设置前拒绝启用。profile 显式安装的依赖和已保存的选择仍保留管理入口。已选中的组合包会在启动时跳过并报告原因，仍可取消选择；已保存的用户设置保留。其他操作系统上的浏览器可以连接受支持的 Mac Host。

准备失败时，已保存的选择保留，CUA 操作不可用。刷新或重新打开插件页查看组件诊断，修复后重启 DSH。

显式启用会进行只读权限检查，可能启动 helper，但不会打开系统授权弹窗。[权限页面](../cua/README.zh.md) 提供系统申请入口、设置跳转和自动检测。任务访问应用前会单独询问用户。应用授权保存在按 profile 隔离的存储域中。会话授权跨 turn、连接、DSH 重启和 Computer Use 启停保留，只在原对话中生效。可以在同一页面撤销授权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者说明</summary>

组合包 patch 通过 `agentPreset: ptc` 挂载原生提供方和权限界面。直接将导出的 `cordis.patch.yml` 用作覆盖层时不会经过组合包准入；行级条件会在其他 Host 上跳过可选的 macOS 提供方。仅加载共享条目不能提供计算机控制。工具通过现有 Agent 作用域注册，preset 文档保持不变。详情页按钮复用现有设置表单，仅在点击后保存 `agent-preset-registry.selectedDefault: ptc`。[CUA](../cua/README.zh.md)负责注册和销毁。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Computer use](../../../docs/subsystems/computer-use.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### Computer Use in PTC sessions

#### What the model sees

已有和新建 PTC 会话通过生成的 SDK 与 `run_code` 使用 `cua`，并获得 CUA 指引。关闭撤回这些贡献，保留 PTC 展示方式。其他 preset 不获得 CUA 贡献。完整接口与输出约定由 [CUA](../cua/README.zh.md) 和 [PTC](../../ptc-runtime/ptc-runtime-node/README.zh.md#persistent-repl) 说明。

#### Token effect

CUA 生效时添加其指引。关闭撤回这些指引，现有 PTC 执行说明保留。

#### KV Cache effect

CUA 生效和卸载会改变 PTC SDK 与系统指引，后续请求使用更新后的前缀。顶层 `run_code` 工具保持存在。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 首次安装需要能访问提供匹配 DSH 版本的注册表。系统权限需用户在 macOS 中确认，安装插件不会自动授予权限。
- PTC 执行方式由 profile 共享，需单独配置。未启用 HMR 的 Host 在重启时应用已保存的变更。

<a id="dev-note"></a>
### 开发备注

None.
