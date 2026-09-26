# Agent Note: 仅通过文件系统提供方读取指令文件

Status: proposed

[English](2026-09-19-provider-only-instruction-reads.md) | 中文

## 问题

[指令发现](../../../../packages/context/agent-instructions/src/files.ts)为元数据探测、根标记发现和有界读取维护了提供方与直接 Node 两条路径。`nodeStatFile`、`nodeTextChunks` 和可选的提供方/目标字段支持后者。导出的 `discoverBaselineInstructionFiles` 包装函数选择该路径；`loadBaselineInstructions` 则允许调用方通过省略提供方来使用它。

仓库中的每个生产调用方都传入提供方。[插件](../../../../packages/context/agent-instructions/src/index.ts)读取 `ctx.get('fs')`，缺失时直接返回；[协调逻辑](../../../../packages/context/agent-instructions/src/state.ts)要求传入 `FileSystem`。直接 Node 路径的消费方都是测试。因此，维护两条路径增加了独立的错误与取消覆盖，却没有服务于已交付的产品路径。

## 提案

在整个发现与加载链路中要求传入 `FileSystem`，包括两个导出的包装函数和 `findProjectRoot`。移除 `nodeStatFile`、`nodeTextChunks`、仅供 Node 使用的路径缺失分类、`existsAsMarker` 的 Node 分支以及 `statFile` 选择器。提供方发现过程给出必需的目标；有界读取通过 `streamText` 消费这些目标。

保留插件缺少提供方时不执行操作的行为，以及纯函数 `renderAgentInstructions` API。保留候选优先级、源文件与渲染输出的字节预算、取消、符号链接跟随和错误语义：候选不可用不能表示应移除已有内容，根标记失败仍是错误。独立的 `skill-filesystem` 所有者保留其现有的无提供方行为。

让直接调用辅助函数的测试改用显式管理生命周期的本地或受控提供方。[测试套件](../../../../packages/context/agent-instructions/tests/agent-instructions.spec.ts)已经挂载了这两类实现。保留独有断言，把重复的 Node mock 场景合并到提供方覆盖中。预计在更新签名和文档之前删除约 50–65 行生产源码，另加冗余测试机制；实施时测量实际减少量。

[符号链接决策](../../implemented/feature/2026-07-21-follow-instruction-symlinks.zh.md)所接受的行为继续存在，因此该说明保持现行状态。实施时，更新其中对两种实现的引用和[包 README](../../../../packages/context/agent-instructions/README.zh.md)，包括双语对侧。[已归档的工作区上下文说明](../../archived/feature/2026-06-24-workspace-context.md)保持冻结；本提案不附带任何既有说明变更。

## 备选方案

**保留无提供方的便利导出。** 它们让外部调用方无需构造提供方便可加载指令，但也要求保留生产路径不使用的第二套 I/O 实现。本提案有意放弃这种便利；仓库搜索不能确定外部无人使用。

**隐式构造本地提供方。** 这会保留省略参数的调用方式，却隐藏文件系统选择和生命周期归属。调用方应传入它们打算使用的实现。

## 验收标准

- 本所有者的发现/读取辅助函数要求提供方，且不含直接 Node I/O 回退；无提供方的插件组合仍不加载任何内容。
- 针对性测试保留符号链接、缺失/不可用、标记错误、预算、取消、恢复、嵌套访问和压缩（compaction）后恢复的行为。
- 工作区上下文恢复的进程预期输出和 `ptc-workspace-context` 场景保持原有文本及事件顺序。类型检查、受影响构建和文档检查通过。

## 风险

省略提供方的外部调用方面临有意的稳定前 API 变更。实施前确认这类需求。保留文件系统扩展路径，也不要用重新创建已移除回退的新便利包装函数替换有用的提供方测试。
