# Agent Note: 用 unlink 删除过期的 profile 回退链接而非 rmSync

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-unlink-stale-profile-fallback-links.md) | 中文

## 问题

`healProfilesModuleFallback` 在安装位置迁移时会把 `$DSH_HOME/profiles/node_modules` 中的条目重新指向新目标，而 Windows 主机上这些条目是 junction。`ensureSymlink` 原先用 `rmSync(link)` 删除过期条目，但 Node 在删除时把 junction 当作目录处理：不带 `recursive` 的 `rmSync` 会抛 `ERR_FS_EISDIR`，于是从迁移后的安装或第二个 worktree 启动时，每次都会在应用引导前崩溃。`replaces a wrong symlink` 单元测试在 Windows 上正好在该删除调用处复现了这一崩溃。

## 决策

`ensureSymlink` 改用 `unlinkSync(link)` 删除过期链接。`unlink` 在所有平台上都只删除重解析点或符号链接本身、绝不进入目标目录，从而保住该函数“真实目录永远不会被删除”的大声失败保证。[profile-plugin-bundles 决策](../architecture/2026-08-05-profile-plugin-bundles.zh.md)继续拥有回退目录的双锚点解析；本 note 只拥有“用哪个删除原语”这一决定。

## 考虑过的替代方案

**`rmSync(link, { recursive: true })`。** Node 24 上它只删 junction、不跟随目标，但 `recursive` 会在 `lstat` 守卫与删除之间链接被替换成真实目录时静默删除该目录，削弱守卫存在所依据的大声失败契约。

**`rmdirSync(link)`。** Windows 上同样能删 junction，但它读起来像“删目录”，而 `unlinkSync` 才是仓库现有的 junction 清理惯例。

**无条件删除并重建所有条目。** 正确，但每次启动都翻动未变化的链接，并扩大并发修复的竞态窗口。

## 后果

Windows 启动现在可以修复迁移后的安装或第二个 checkout，而不是以 `ERR_FS_EISDIR` 崩溃；POSIX 行为不变，因为 `unlinkSync` 同样能 unlink 普通符号链接。现有的 `replaces a wrong symlink` 测试在 Windows 上从复现崩溃变为通过。两个并发 healer 删除同一过期链接时，第二次删除仍会以 `ENOENT` 浮现，与原先的 `rmSync` 实现一致。
