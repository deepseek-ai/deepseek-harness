# Agent Note: 统一未读取文件系统工具诊断

Status: implemented

[English](2026-09-03-normalized-unread-fs-tool-diagnostic.md) | 中文

## 问题

`dsh-tool-fs` 的 write 和 edit 操作可能从观测策略或文件系统提供方收到 `FS_NOT_OBSERVED`。这些来源用操作特定消息描述相同要求，因此相同恢复条件会以不同措辞到达模型。提供方文本还可能暴露被拒绝的操作是否会覆盖既有目标，但模型只需读取目标后重试。

## 决策

`remediateFsError(error, displayPath)` 在 `dsh-tool-fs` 模型边界把每条 `FS_NOT_OBSERVED` 消息替换为 `cannot modify "<path>": file has not been read — read the file, then retry`。包装层保留结构化错误码，并把来源错误链为 `cause`，因此机器路由与诊断仍能检查原始故障。

`FS_STALE_VERSION` 继续使用[受防护变更恢复指令记录](../feature/2026-08-03-fs-tool-error-remedy.zh.md)拥有的追加式重新读取指令。文件系统提供方与策略保留其操作特定消息，因为其他消费方并不共享该工具面向模型的呈现。

## 考虑过的替代方案

**为每条来源消息追加相同恢复后缀。** 不予采纳，因为模型仍会为同一项必要操作收到不同原因，其中包含不会改变恢复方式的提供方目标存在性细节。

**在提供方与策略源头统一消息。** 不予采纳，因为这些组件拥有供 `dsh-tool-fs` 之外消费方使用的面向机器错误；只有该工具拥有这段模型可见措辞。

**为统一后的结果引入另一个错误码。** 不予采纳，因为底层条件与恢复路由仍是 `FS_NOT_OBSERVED`；改变错误码会丢失机器消费方需要的兼容性。

## 后果

无论变更由策略还是提供方拒绝，write 和 edit 都会给出同一条稳定的未读取目标诊断。模型放弃来源特定措辞和提供方的目标存在性提示，以换取一条统一且可执行的恢复指令。原始消息仍可通过 `cause` 获取。

单元与集成测试固定两条来源路径、错误码保留、cause 链和模型可见文本全文。`fs-policy-reject` 录制会话携带同一条诊断用于重放。
