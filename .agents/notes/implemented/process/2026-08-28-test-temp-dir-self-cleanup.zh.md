# Agent Note：单测删除自己创建的 dsh-* 临时目录

Status: implemented

[English](2026-08-28-test-temp-dir-self-cleanup.md) | 中文

## Problem

测试进程用 `mkdtemp(join(tmpdir(), 'dsh-*'))` 创建 `/tmp/dsh-*` 目录后不清理。在自托管 Linux CI 主机上（32 个 runner 实例共享一个 `/tmp`），残留两次耗尽根分区 inode（issue #3134，2026-08-13 与 2026-08-26）。机器侧 `dsh-tmp-sweep` timer 与 CI lane sweep（保留未合并，在分支 `fix/ci-tmp-residue-cleanup` 上）都是事后删除残留，未修掉产生残留的缺陷本体。人类 review #3233（2026-08-28）否决了 sweep：单测应改为自己清理创建的目录。

## Decision

为 spec 文件创建的每个 `dsh-*` 临时目录补上删除路径，挂在所属测试的 teardown 上：

- 创建目录但从不删除的 spec 文件，现在把每个创建的 root 记入模块级列表，并在 `afterEach`/`afterAll` 里删除（`rm`/`rmSync` 带 `recursive: true, force: true`）——与 session 包既有的 `roots.splice(0)` 约定一致。创建 root 的 helper（`tmp()`、`tempDir()`、`fakeLauncher()`、harness 函数）在创建处登记，一个点覆盖全部调用方。
- 整文件共享的模块级 fixture 目录（executor spill 目录）在最后一个测试之后的 `afterAll` 里删除。
- 目标文件清单来自 CI 主机上的残留实测清单（当前 `/tmp/dsh-*` 目录的模板直方图）：只有目录确实出现在残留里的 spec 文件才是泄漏源。已有删除逻辑的文件（agent-team、tool-subagent、list-children、hooks coverage cases）确认在正常结束路径上本来干净，不改。
- 产品侧清理限定在 `dsh-subprocess-local/spawn` 的每进程 spill 目录（`privateSpillDir`）：在 JavaScript 可观察的进程退出时，仅当目录**未持有任何已完成的 spill 文件**才删除——已完成的 spill 文件作为完整输出恢复产物保留到外部清理，因此只有从未 spill 过的目录（CI 主机残留的主流形态：抽样 `dsh-subprocess-*` 目录 92% 为空）会被删除。删除是 best-effort（ENOENT/ENOTEMPTY/EBUSY/EPERM 不得改变退出码）。`dsh-spill-local` 的默认 root **刻意不做**退出删除：该 root 由包自带的 30 天启动 sweep 覆盖，且[保留策略 note](../architecture/2026-07-17-local-spill-startup-cleanup.zh.md)禁止删除 resume/fork 会话仍可能引用的新 spill 产物。

## Verification

- 本地定向跑过全部改动单测 spec 通过（36 个改动的 `*.spec.ts` 文件，分组运行），含直接使用改动后产品源码的套件；2 个改动的 web `*.e2e.ts` 由 web e2e lane 承载。
- CI 在 Linux 与 Windows coverage lane 跑改动 spec；一次全绿后，被修文件的残留模板（实测每两小时最多各约 5,000 个目录，如 `dsh-profile-`、`dsh-app-boot-`、`dsh-presets-*`、`dsh-upload-index-`）应不再出现在 CI 主机的新鲜 `/tmp` 残留里。

## Alternatives considered

### 保留纯 sweep 方案（review 否决）

Sweep 步骤与 timer 只删已存在的残留；本地运行仍会累积，机器 sweep 也区分不了已死 run 的残留与存活 run 的目录。review 的决定是逐测试清理，本实现覆盖正常结束路径。

### 引入共享临时目录 helper 包

未选：泄漏文件各自通过自己的小 helper 创建 root，在那些 helper 处登记是每个文件单点改动；新增 test-support 包只会增加依赖，不减少逐文件审计量。

## Consequences

- 收益：正常结束（含测试失败）时，spec 的 `dsh-*` 目录在 teardown 删除；`dsh-subprocess-local` 未持有任何已完成 spill 文件的每进程 spill 目录在 JavaScript 可观察的进程退出时删除。
- 代价：被 SIGKILL 的进程（run 被取消、超时被杀）无法运行任何进程内 teardown，飞行中的残留仍在——机器侧 timer 继续兜底该路径。
- 代价：子进程创建的目录只有在测试知道其路径时才被覆盖；产品自有、仍持有 spill 文件的目录与 `dsh-spill-local` 的默认 root 按既有保留策略保留文件，由该包自身的 sweep 清理。
