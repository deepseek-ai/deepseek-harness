# Agent Note: Windows 原生持久 JSONL 发布

Status: implemented
Archived: 2026-09-30

[English](2026-07-05-windows-jsonl-durable-publish.md) | 中文

## 问题

`dsh-session-persistence-jsonl` 在首次追加时延迟发布会话日志。POSIX 协议会写入临时文件，对其执行 fsync，将其链接至最终名称，对父目录执行 fsync，然后移除临时链接。对父目录执行 fsync 是持久性约定的一部分：命名空间变更后发生崩溃时，已经提交的最终名称不能丢失，否则调用方会误以为会话日志已经物化。

Windows 具备原子命名空间操作，但 Node 没有暴露与 POSIX 等价的父目录 fsync 约定。如果把 Windows 目录同步失败视为成功，就会在无提示的情况下削弱持久化后端。因此，Windows 路径需要采用不同的发布原语，而不是在 POSIX 的 `syncDir` 辅助函数中添加条件分支。

## 决策

JSONL 后端会在 `materialize()` 内部、任何命名空间变更之前分流。共享代码计算会话目录、最终日志路径，以及编码后的 header 和初始事件批次；随后 POSIX 与 Windows 分别执行各自的发布协议。

POSIX 保留现有协议：创建根目录、项目目录与会话目录，并对其父目录执行 fsync；写入临时文件并对其执行 fsync；使用 `link()` 发布，确保绝不覆盖已有的最终日志；对会话目录执行 fsync；最后移除多余的临时硬链接。

Windows 通过持久的暂存发布来创建缺失目录：创建一个以固定的 `.dsh-mkdir-` 为前缀的随机同级目录，其名称与目标基本名无关；随后使用 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` 将其发布为最终目录名称，且不使用 `MOVEFILE_REPLACE_EXISTING` 或 `MOVEFILE_COPY_ALLOWED`。文件物化先写入临时日志并对其执行 fsync，再以同一个启用写穿透的 `MoveFileExW` 调用将临时文件发布到最终路径，并且同样不允许替换。`koffi` 是覆盖这组 API 所需的最小 Win32 桥接层；`pnpm-workspace.yaml` 允许执行它的安装脚本，因为该包会分发原生 loader 和预构建的平台模块。

## 考虑过的替代方案

**忽略 Windows 目录同步失败。** 不予采纳，因为这会在没有强制将已发布的命名空间条目写入稳定存储时，就把首次追加报告为持久化成功。

**使用 `CreateHardLinkW`。** 不予采纳，因为硬链接依赖文件系统、不能发布目录，并且没有提供写穿透选项。

**使用替换或事务型 API。** `ReplaceFileW` 的替换语义与拒绝同一 id 冲突的要求相悖，而新应用设计不应使用 Transactional NTFS。

## 影响

该后端在各平台上维持同一项外部约定：首次追加要么把完整日志发布到最终名称，要么失败且不覆盖已有日志。平台分流只是实现细节；`SessionPersistence` API 和 JSONL 逻辑记录格式均不改变。后续的 [Zstandard 编码决策](2026-07-19-zstandard-jsonl-session-logs.zh.md)会先作用于不透明字节，然后才由任一平台执行发布。

Windows 测试会在原生 Windows 上执行真实的 Win32 发布路径。断电行为属于 API 约定属性，单元测试无法证明；可测试的不变量包括：Windows 物化不会调用目录 fsync、最终路径冲突会失败、达到最大长度的目标路径组件仍可物化、临时日志在发布前已经执行 fsync，并且生成的日志可以正常加载。

两个平台的追加和修复仍使用普通文件句柄 fsync。追加失败后，系统会关闭仅追加句柄，以读写模式重新打开日志，将文件截断到追加前的大小，并对回滚结果执行 fsync，因为 Windows 不允许在仅追加句柄上调用 `ftruncate`。
