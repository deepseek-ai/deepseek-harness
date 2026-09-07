# Agent Note: 递归删除前先解链 fixture junction

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-unlink-fixture-junctions-before-delete.md) | 中文

## 问题

install-lefthook 与 translation-pairing 的 fixture 把仓库真实的 `scripts/`、`node_modules` 和 tsx 包目录用 junction 链进 fixture 树，让 installer 探测能穿透解析。Windows 的递归删除可能把 junction（MOUNT_POINT 重解析点）当作目录并跟随进其目标；Git 的 `worktree remove` 正是这样删掉了仓库被跟踪的 `scripts/` 和 tsx 包（事故的插桩把删除定位到这一步）。因此，信任删除器的 fixture 清理删掉的是仓库自己的源码，而不是 fixture。

## 决策

`scripts/test-fixture-cleanup.ts` 拥有 junction 安全的 fixture 拆除：`unlinkFixtureLinks` 先遍历并解链所有重解析点，`removeFixtureSafely` 再删除已无链接的树（带 Windows 异步句柄重试）。所有受影响的 `afterEach` 和 `worktree remove` 前的钩子都调用它。通用规则记录在 `docs/defensive-patterns.md`：链接形态的路径用 unlink 删除，递归 `rmSync` 只留给确知为真实目录的路径。

## 考虑过的替代方案

**只信任递归删除。** 否决：特定删除器是否跟随 junction 随工具和版本而异，而 `git worktree remove` 这一条路径已经摧毁过被跟踪文件；任何清理都不该拿仓库去赌这个行为。

**复制而不是 junction 真实目录。** 否决：fixture 的意义就是用真实内容探测真实 installer 路径，复制品会失去被测边界。

## 后果

fixture 拆除不再能穿过 junction 触及仓库源码。额外开销只是对小型 fixture 树的一趟 lstat/unlink。这个摧毁数据的缺陷现在在 defensive-patterns 规则旁有了持久化的原因，helper 也是未来所有 junction fixture 共享的拆除路径。
