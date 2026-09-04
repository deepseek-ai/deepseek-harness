# Agent Note: 陈旧版本错误在模型边界追加恢复指令

Status: implemented

[English](2026-08-03-fs-tool-error-remedy.md) | 中文

## 问题

受防护的 `write` 与 `edit` 失败以只陈述条件、不给出唯一正确恢复方式的消息到达模型：`FS_STALE_VERSION`（「file changed since it was read」）与 `FS_NOT_OBSERVED`（「edit requires reading … first」）。模型必须自行猜测恢复方式是重新读取（或首次读取）后重试，而基于结构化错误码路由的重试/权限/UI 层看到的也是同一段消息文本。提供方拥有的消息属于存储 seam 的面向机器词汇（[文件系统能力 seam](../architecture/2026-06-17-filesystem-capability-seam.zh.md)），因此恢复指令不能放在那里，否则会把面向模型的措辞泄漏给 `FsError` 的每个消费方。

## 决策

`dsh-tool-fs` 拥有一个面向模型的错误包装层 `remediateFsError`（位于 `src/error.ts`），在 `write.ts` 与 `edit.ts` 中于沙箱拒绝映射之后应用。它为陈旧版本错误追加恢复指令，其余无关错误原样透传。[未读取变更的统一诊断](../bug-fix/2026-09-03-normalized-unread-fs-tool-diagnostic.zh.md)取代本记录最初对 `FS_NOT_OBSERVED` 文本的处理方式。

- `FS_STALE_VERSION`（包括缺失的编辑目标——它与陈旧错误共用同一错误码）追加 `— re-read the file, then retry`。

结构化 `FsError` 错误码保持不变，使重试/权限/UI 层继续基于它路由；原始错误作为 `cause` 链入。提供方消息保持面向机器且不变。

在 `edit.ts` 中，`fs/edit-intent` waterfall（瀑布式事件）与提供方变更位于同一个 `try` 内，因此策略插件的 `FS_NOT_OBSERVED` 拒绝和提供方拒绝都会经过面向模型的包装层。

## 考虑过的替代方案

- **在 `dsh-fs` / `dsh-fs-local` 的提供方消息中追加恢复指令。** 被拒绝：这些消息是面向机器的 seam 词汇，被重试、权限、UI 和面向模型的各层消费；面向模型的措辞应位于模型边界，即 `dsh-tool-fs` 已经拥有结果格式化之处（[文件系统能力 seam](../architecture/2026-06-17-filesystem-capability-seam.zh.md)）。
- **改为在提示词引导中加入恢复方式。** 被拒绝：失败发生在任务中途；静态指令无法可靠地影响重试决策，而错误消息恰好在模型必须行动时出现。
- **用新的 `FsError` 错误码表达恢复指令。** 被拒绝：这两种失败对应的条件，重试层本就已经处理；拆分错误码会使相同语义采用不同路由。

## 后果

`FS_STALE_VERSION` 的模型可见文本包含追加的恢复指令。单元测试覆盖该文本、错误码保留、cause 链和无关值透传；组装后的工具路径断言恢复指令到达模型。

[文件系统缺失观测后续决策](../bug-fix/2026-08-09-filesystem-absence-observation.zh.md)使外部删除场景下的陈旧恢复指令能够生效。失败的重新读取仍返回 `FS_NOT_FOUND`，但会记录确认缺失：随后 edit 返回 `FS_NOT_FOUND`，不再附加陈旧恢复指令；write 则以原子 `createIfAbsent` 重试，并保留任何并发创建者写入的文件。
