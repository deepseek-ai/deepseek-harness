# Agent Note: 解析 Microsoft Store 的 pwsh 别名

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-resolve-store-pwsh-aliases.md) | 中文

## 问题

`resolvePwshPath` 声称 Store 安装经 PATH 解析，但它的存在性探测用的是 `existsSync`，会对候选做 stat、从而跟随重解析点。Store 的 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` 是 app execution alias，其目标目录的 ACL 拒绝 stat（EACCES），于是 `existsSync` 看不到它，解析静默落到 Windows PowerShell 5.1——在这类「唯一的 PowerShell 7 是 Store 安装」的机器上就用了错误的 shell。

## 决策

`candidateExists` 接受「stat 为文件」或「lstat 为链接形态重解析点」的候选，`resolvePwshPath` 改用它。spawn 别名路径可以工作，因为 CreateProcess 会解析 app execution alias。悬空的链接形态候选同样被接受，让损坏的 pwsh 在 spawn 时响亮失败，而不是静默降级到 5.1。

## 考虑过的替代方案

**直接探测 WindowsApps 包目录。** Store 包路径带版本且被 ACL 隐藏；硬编码它只是重复了 PATH 加别名已经拥有的打包知识。

**对 stat 失败继续走 5.1 回退。** 否决：它静默运行了一个并非所装的 shell，这正是本 note 修复的缺陷。

## 后果

Windows 上 Store 安装的 PowerShell 7 现在先于 5.1 回退被解析；普通文件候选和非 Windows 平台行为不变。悬空 symlink 单元测试在全部平台上钉住 stat/lstat 的分裂行为。
