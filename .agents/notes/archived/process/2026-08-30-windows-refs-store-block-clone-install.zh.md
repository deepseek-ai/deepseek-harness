# Agent Note: Windows 自托管 ReFS store 与块克隆安装

Status: implemented
Archived: 2026-09-04

[English](2026-08-30-windows-refs-store-block-clone-install.md) | 中文

## Problem

自托管 Windows 虚拟机的工作区从 NTFS 的 `E:` 卷迁到了 ReFS 的 `F:` 卷。在 NTFS 卷上，`git clean -ffdx` 删除约 7 万个文件的 node_modules 树需要几十分钟，并迫使每次运行全量重装，把磁盘写入推到该卷持续带宽以上。ReFS 的元数据操作快几个数量级，因此工作区迁移恢复了快速 checkout，但暴露了第二个失败。

pnpm store 也在 `F:` 上（`F:\.pnpm-store`），因此 pnpm 用硬链接把 node_modules 文件链接到 store（同卷布局下的默认 `package-import-method=auto`）。TypeScript 用原生 realpath（`fs.realpathSync.native`）解析模块文件，在 Windows 上会把硬链接解析到 store 的内容寻址路径（`F:/.pnpm-store/v11/files/<xx>/<sha256>`）。编译器随后从那个 store 路径解析裸导入，而那里没有 `node_modules`，于是在 `tsc -b` 和 vite 的模块解析期间以 TS6231（`Could not resolve the path 'F:/.pnpm-store/...'`）失败。JS 的 `realpathSync` 不泄漏 store 路径；只有原生变体会泄漏，所以这只出现在编译器工具链里。

当 `package-import-method=clone` 运行在不支持 copy-on-write 的卷上时，会出现相关的安装失败：pnpm 在 NTFS 卷（托管 runner）上报告 `ERR_PNPM_LINKING_FAILED ... Source volume does not support copy-on-write`。

`pnpm/action-setup` 装到其 `dest` 的 pnpm 构建缺少 clone 模式所需的 `@reflink/reflink` 原生模块，所以即使在 ReFS 上，clone 也会以 `Cannot find module './reflink.win32-x64-msvc-*.node'` 失败。系统 corepack pnpm 带有完整的 `@reflink` 平台集合，包括 `reflink.win32-x64-msvc.node`。

## Decision

[ci.yml](../../../../.github/workflows/ci.yml)（四个 pull-request 原生作业）和 [ci-master.yml](../../../../.github/workflows/ci-master.yml)（`serial-windows`）中的 Windows 安装步骤按工作区文件系统分支，仅在 ReFS 上使用 clone：

```pwsh
$drive = (Split-Path -Qualifier $env:GITHUB_WORKSPACE).TrimEnd(':')
$fs = (Get-Volume -DriveLetter $drive).FileSystem
if ($fs -eq 'ReFS') {
  corepack pnpm install --frozen-lockfile --package-import-method=clone
} else {
  pnpm install --frozen-lockfile
}
```

- ReFS 上的 `--package-import-method=clone` 使用块克隆：每个 node_modules 文件获得独立路径（因此原生 realpath 无法把它解析回 store 路径，消除了 TS6231），同时与 store 共享物理块（无复制代价）。ReFS 支持块克隆和硬链接（已用 `fsutil fsinfo volumeinfo` 和硬链接列表验证）。
- 仅当工作区卷是 ReFS 时才传该 flag。托管 runner（NTFS，每个 job 全新 VM）保留默认导入方式，因为 NTFS 拒绝块克隆。
- 使用 `corepack pnpm` 是因为 clone 模式需要 `@reflink/reflink` 原生模块，系统 corepack pnpm 带有它，而 `pnpm/action-setup` 的 dest 构建缺少。
- `.npmrc` 与 `npm_config_*` 环境变量在 Windows 的 pnpm 11.7.0 上不驱动 `package-import-method`；只有 CLI flag 生效，因此命令中显式传 flag。

自托管虚拟机的 store 位于 `F:\.pnpm-store`（ReFS，机器级 `PNPM_CONFIG_STORE_DIR`），工作区位于 `F:\ci\_work-NN`。重建后 F: 卷为 200 GB ReFS。`DSH_CI_FAILOVER_WINDOWS=selfhosted` 把四个 pull-request 原生作业路由到自托管池。

## Alternatives considered

- **把工作区留在 NTFS 的 `E:`** - 不采纳，因为 NTFS 上 `git clean -ffdx` 删除 node_modules 树需要几十分钟，即最初的写风暴根因；ReFS 把它降到约 23 秒。
- **`--package-import-method=copy`** - 避免 store 路径泄漏（文件是独立副本）且不需要原生模块，但每次安装都从 store 复制每个文件，恢复了工作区迁移移除的大部分写代价。
- **修复 action-setup 的 pnpm 的 reflink** - 不采纳，因为 `pnpm/action-setup` 把全新 pnpm 装进每 job 的 `dest` 目录；在那里补原生模块脆弱且按 job 生效。
- **`.npmrc` 的 `package-import-method=clone`** - 不采纳，因为 Windows 的 pnpm 11.7.0 忽略它（已验证：文件保持 `nlink=2` 的硬链接，原生 realpath 仍泄漏 store 路径）。

## Consequences

自托管 Windows 安装使用块克隆，既得到独立文件路径（无 TS6231），又共享物理块（无复制）。托管 runner 保留默认导入方式。`serial-windows` standby drill 与自托管池上的 pull-request 原生作业依赖 ReFS 卷布局；若按 [failover runbook](2026-07-26-ci-failover-runbook.zh.md) 重建 runner 而没有 ReFS store 与工作区布局，Windows 构建门禁会以 TS6231 失败（或安装阶段以 reflink 错误失败）。
