# Agent Note: apply_patch 文件编辑

Status: implemented

[English](2026-09-28-apply-patch-file-editing.md) | 中文

## 问题

模型编辑多个文件或分离区域时，需要多次字面量编辑调用或 shell 脚本。shell 和 Python 编辑不发出文件系统修改 intent，因此没有 Git 的工作目录无法在轮次 Review tab 中可靠呈现这些修改。补丁工具用一次调用表达相关编辑，同时保留受保护的文件系统操作。#5121 要求实现能力并评测效果；#4556 提供高效文件编辑的更广泛动机。

## 决策

`apply_patch` 接收一份 Codex 风格补丁，支持新增、更新、删除和移动，以及多个文件和 hunk。[dsh-fs-patch 纯库](../../../../packages/fs/fs-patch/README.zh.md)遵循 Codex `rust-v0.158.0` 的解析、顺序匹配、空白容忍和 `NormalizeToLf` 重建。匹配器只接收 LF 文本，因此不实现 Codex `PreserveLineEndings`。

[文件系统服务](../../../../packages/fs/fs/README.zh.md)提供 `patchText`、`deleteFile` 和 `moveFile`；本地、沙箱和 SSH 提供方均实现它们。`fs/delete-intent` 与 `fs/edit-intent` 要求相同的存在观察，移动目标使用 `fs/write-intent`。版本防护和沙箱约束仍由提供方负责。移动先发布目标，再删除源；`sourceDeleted` 区分已完成的移动与目标已发布但源未能删除的情况。

[工具执行器](../../../../packages/fs/tool-fs/README.zh.md)在整份补丁预检时解析路径并模拟预期状态，包括重复路径和移动，不写入文件；预检拒绝时没有提交。提交时为每条操作重新获取观察防护，在首次失败或取消时停止，不回滚。I/O 或取消失败后，`stat` 比较检查所有受影响目标是否仍保持先前版本；状态变化或比较失败会产生 `unknown`，要求重试前重新读取。报告保留已完成、失败、未知和跳过的操作，包括部分发布的移动。

提交报告返回 `isError: false`，让已完成的 diff 元数据在补丁中止后仍被保留；操作状态和 stopped 标记暴露失败。语法和预检拒绝产生工具错误。成功移动的摘要使用 `M <destination>`。已应用 diff 的路径采用规范绝对 `processPath`，供客户端导航使用；操作记录保留显示路径，未解析的路径保留补丁原始写法。

[Review 采集](../../../../packages/deliverables/workspace-changes/README.zh.md)使用文件系统 intent 监听器，不解析参数。`tools/pre-execute` 将执行关联到轮次记录器；前置的 write、edit 和 delete 监听器先等待策略决策，再等待捕获完成，然后提供方才修改文件。移动捕获两端。每轮保留首次基线，比较实际最终字节，因此重复编辑形成一份净 diff，还原的变化不再显示。现有大小、数量、时间、位置和 Session 生命周期限制保持适用。

`tool-fs.applyPatch` 默认为 `false`，因此所有随发行版交付的组合保持该工具出现之前的模型请求；启用 `edit` 的 `tool-fs` 行（`dsh-base` 以及 Web 的 `standard`、`ptc`、`cordis` preset）显式写出 `applyPatch: false`，部署只需改这一行即可开启，或在没有 preset 拥有该行时通过针对 `tool-fs` id 的 profile patch 开启。该工具像 `write` 和 `edit` 一样咨询 `fs/*` intent waterfall，因此已挂载的观察策略对每个补丁操作要求先读并拒绝过期版本。schema 沿用 Codex 的参数名 `input`：在 2,226 条 DS-Bench 与 DeepSWE 录制轨迹中，14% 的 `apply_patch` 调用带着这个键发出，而参数名为 `patch` 时它们都被拒绝。工具通过插件 effect 注册 schema、指导文本、native/PTC 执行与调用展示；不修改 agent loop（智能体循环）。

## 考虑过的替代方案

**继续使用 shell 或 Python 打补丁。** 这使非 Git 修改缺少文件系统 intent 采集，也不能提供所需的模型文件编辑工具。

**复用 Codex 标记但采用独立的严格匹配器。** 这能减少初期实现工作，但会让熟悉的补丁以不同方式失败。固定 Codex 解析器和匹配器使偏差可审查；Harness 策略继续显式存在。

**将整份补丁做成事务。** 跨文件回滚增加恢复状态，还可能覆盖并发外部修改。预检和顺序提交可以提早拒绝已知失败，并公开部分结果，而不承诺回滚。

**加入工具时同时扩展 Review。** 重命名展示、持久存储、SSH 采集和捕获失败策略是独立产品决策；既有整文件采集和展示覆盖本次接入。

**在同时启用 `write` 与 `edit` 的地方默认注册该工具。** 这会在尚未衡量该工具对普通会话的影响之前，给每个默认模型请求增加一个 schema 和一段指导文本，并改变所有录制请求的预期；显式开关保持基线组合不变，让对比评测自行选择开启。

## 后果

一次调用可以表达相关编辑。默认模型请求保持不变；开启该开关的组合会包含额外的工具 schema 及其指导文本，因此其录制请求的预期与基线不同。预检不能阻止之后的冲突、取消或存储失败；调用方在重试前检查操作状态。上游宽松匹配保持固定版本并受到测试约束，不会被收紧。提供方实现和外部子类必须支持三个新增操作，部分移动要求处理两端状态。

## 测试

解析器和匹配器 fixture 覆盖固定版本的语法、空白、重复上下文与 EOF 行为。提供方和执行器测试覆盖观察、版本和沙箱拒绝、重复路径、部分移动、取消和未知结果。真实工具 Review 矩阵分别在无仓库和 Git 不可用环境运行，检查所有操作类型、首末基线、被拒编辑、部分发布、还原变化、采集顺序、无效语法与路径别名。真实模型 Session 录制覆盖成功更新、读取策略拒绝后重试与部分执行；确定性取消保留在执行器测试中。

## 延期工作

受控编辑任务评测：在相同初始状态下与 `edit` 比较最终文件正确性、任务成功率、token、工具调用、重试、延迟和 Review 覆盖。SSH Review、`apply_patch` 的收尾文案文件引用，以及 Codex `PreserveLineEndings`。
