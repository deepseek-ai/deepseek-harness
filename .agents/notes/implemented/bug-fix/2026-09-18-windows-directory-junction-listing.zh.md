# Agent Note: 列举工作区文件树中的目录链接

Status: implemented

[English](2026-09-18-windows-directory-junction-listing.md) | 中文

## Problem

Windows 的个人目录如 `Documents\My Music` 是目录联接：`lstat` 把这类重解析点报告为符号链接而不是目录。`list` 端点在解析之前先用 `lstat` 把关，于是把所有末端链接都以 `workspace-file/not-directory` 拒绝；而它自己的列举又把同样的子项报告为 `directory`，因为 `listDir` 会解析每个子项。文件树因此既列出这些联接、又拒绝打开它们，侧栏把 `My Music`、`My Pictures`、`My Videos` 报告为非目录。

## Decision

`list` 跟随末端链接并判定其解析结果。解析后的目标必须通过工作区包含检查，且经 stat 必须为目录，因此工作区内的目录链接经其目标列举，返回的工作区路径也以该目标命名。解析到工作区外的链接为 `workspace-file/outside-workspace`；指向非目录的链接、或目标已消失的链接，为 kind 为 `symlink` 的 `workspace-file/not-directory`。

`read`、`readBytes`、`readAll`、`readRelated` 与 `stat` 保留拒绝末端符号链接的 `lstat` 把关，因此没有任何读取路径跟随链接。[工作区文件服务](../architecture/2026-09-05-workspace-files-service.zh.md)继续拥有该服务；它此前「`list` 拒绝末端符号链接」的规则由本记录取代。

## Alternatives considered

**对所有方法去掉 `lstat` 把关。** 被否：经链接读取是另一项暴露决策，文件方法的「不跟随」规则是报告方要求保留的信任规则。

**单独处理 Windows 目录联接。** 被否：`fs-local` 已把目录联接报告为 `symlink` 路径项，且「先解析再判包含」的规则对目录联接与 POSIX 目录符号链接完全相同。

**保留把关，只靠父层列举报告被链接的目录。** 被否：列举本来就报告解析后的类型，端点因此自相矛盾，读取方无法打开父层呈现为目录的条目。

## Consequences

工作区内的目录链接现在与其目标一样可列举，Windows 个人目录中的联接可在侧栏展开。解析到工作区外的链接报告 `outside-workspace` 而不是 `not-directory`，如实说明原因。读取权限不变。测试覆盖工作区内的目录链接、解析到工作区外的链接，以及目标被删除的链接；spec 在 Windows 上用 `symlink(target, path, 'junction')` 创建目录联接，在其他平台创建目录符号链接，因此同一 spec 两端都跑。
