# Agent Note: 经离开工作区根的链接列举和监听目录

Status: implemented

[English](2026-11-20-workspace-directory-links-outside-root.md) | 中文

## Problem

`list` 与 `changes` 只按解析后的目标判定目录：`ctx.fs.contains(root, target)` 必须成立。因此，工作区内解析到工作区根外的目录链接在其父目录的列举结果中显示为目录，打开时却以 `workspace-file/outside-workspace` 失败。其下的文件仍然可读：`read`、`readBytes` 与 `stat` 沿用 Session 文件系统后端的读取权限，[工作区文件读取权限](2026-09-09-workspace-file-read-authority.zh.md)不把它限制在工作区内。这一拒绝只隐藏了链接之下的名称，读者只能让 Agent 逐个给出文件链接。

## Decision

目录以两种方式之一通过 `list` 与 `changes` 的工作区检查：其解析后的目标在工作区根内，或其请求路径由工作区根逐级经子项名称向下写出。[`src/descent.ts`](../../../../packages/api/workspace-files/src/descent.ts) 中的 `workspaceDescent` 判定第二种：它按路径的写法判定，不解析链接；对含 `..` 段的路径、位于根旁或根之上的绝对路径，以及另一个 Windows 盘符上的路径不返回结果。拒绝 `..` 段，是因为链接之后的 `..` 段指向链接目标的父目录，而工作区内没有链接指向该目录。

列举结果以解析后的位置命名工作区根内的目录，以请求路径命名工作区根外的目录。工作区根外的绝对目录和解析到根外的 `..` 路径仍是 `workspace-file/outside-workspace`。搜索不跟随链接，文件方法保持不变。

本记录取代此前的两项选择。[Workspace Files 服务](2026-09-05-workspace-files-service.zh.md)与[工作区文件读取权限](2026-09-09-workspace-file-read-authority.zh.md)让 `list` 与 `changes` 只按解析后的包含关系判定目录，[已归档的目录链接列举记录](../../archived/bug-fix/2026-09-18-windows-directory-junction-listing.md)拒绝解析到工作区外的链接。

## Alternatives considered

**只保留解析后的包含检查。** 否决：Session 后端已经向同一调用方提供这些文件的内容，因此这一拒绝只隐藏了目录条目名称，而文件树展示了一个打不开的目录。

**移除 `list` 与 `changes` 的工作区检查。** 否决：调用方将可以按绝对路径枚举 Host 上的任意目录。按所选规则，到达根外目录需要工作区内存在一个链接。

**要求为每个根外目标单独授权。** 否决：后端的读取权限已经覆盖该目标，第二次批准会使浏览比读取受到更多限制。

**逐级解析路径的每个祖先，直到其中一个等于根。** 否决：每次列举都要为每个路径段做一次后端解析，在远程后端上每次解析都是一次往返。把路径的写法与 `WorkspaceFileScope.workspaceRoot` 比较不需要任何解析。

## Consequences

侧栏文件树可以展开解析到工作区外的目录链接，列出其下的目录，并通过监听刷新它们。指向范围很大的目录（例如文件系统根）的链接，会向 Session 的所有者显示该目录的条目名称，而所有者的文件读取本来就能到达那里。`workspaceFiles` 的每个方法在 Liveshare 中仍仅限所有者。

按 `WorkspaceFileScope.workspaceRoot` 以外的根写出的路径，例如本身经链接到达的 Session 目录的规范写法，只能通过解析后的包含检查，因此对这种写法，解析到工作区外的链接仍被拒绝。搜索结果不包含目录链接之下的条目。
