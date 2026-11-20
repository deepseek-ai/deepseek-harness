# Agent Note: Office 技能渐进加载与普通 shell 执行

Status: implemented

[English](2026-09-27-progressive-office-skills.md) | 中文

## 问题

合并的创作和渲染说明会为普通编辑无关的操作消耗上下文。渲染工具激活增加第二条发现路径和持久状态，而 shell 工具已经负责执行权限及进程管理。缺少渲染器也可能阻止加载原本可用的编辑指南。

## 决策


[Office 提供者](../../../../packages/skill/skill-office/README.zh.md)以技能形式提供 Office 指导，由模型按名称加载；宿主不会按文件扩展名注入说明。本决策引入了一个路由技能、三个各格式创作技能，以及通过普通 Bash 或 PowerShell 调用共享 Python 检查器和配置的 LibreOffice Kit CLI 的操作技能，并且只由 SDK 和 Desktop 挂载。[Office 技能在所有部署中可用](2026-10-26-cross-deployment-office-kit.zh.md)取代其挂载决策；[按需激活的 Office 工具](2026-10-31-native-office-tool.zh.md)取代操作技能、其 shell 执行方式和对渲染工具的否决；[单个 Office 技能](2026-11-06-single-office-skill.zh.md)以携带精简内联指导的单一 `office` 技能取代路由技能和创作技能。

载体负责解释器和资源位置：由组合选择 `office` 正文中注明的 Python 环境，以及存放该技能的资源根目录。加载说明不准备引擎或创作 payload。模型编写的脚本通过普通 shell 工具运行，保留现有权限和进程管理。

LibreOffice Kit 依赖在每个清单中声明同一个精确版本；根锁文件记录实际解析的适配器与引擎版本。

## 考虑过的替代方案

**保留专属渲染工具。** 小型类型化 schema 能约束渲染参数，但需要专属执行配置、作用域注册、投影和激活生命周期。CLI 操作技能接受 shell 引用和模型选择参数的成本，以复用现有审批、沙箱、取消及输出机制。

**从目录隐藏子技能。** 这需要独立于调用权限的通用可见性策略。[单个 Office 技能](2026-11-06-single-office-skill.zh.md)直接移除子技能，而不是隐藏它们。

**按文件扩展名自动注入指南。** 扩展名无法区分文本编辑、重计算、转换和用户要求的视觉检查。模型选路使无关操作不进入上下文，并允许显式直接调用。

## 影响

说明加载追加普通的已记录技能结果；操作完成不会擦除这些结果。历史工具记录仍可读取，恢复会话使用现有声明更新机制，无需修改 Session 格式或 agent loop。[按需激活的 Office 工具](2026-10-31-native-office-tool.zh.md)记录了采用专属渲染器的理由。

验证覆盖目录条目、拒绝及显式调用、无可执行文件路径时的创作、native／PTC 请求、恢复和 fork、常规及 minimal 组合、资源打包、上下文预算和真实模型操作选择。
