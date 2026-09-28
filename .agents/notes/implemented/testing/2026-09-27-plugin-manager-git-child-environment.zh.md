# Agent Note: plugin-manager 的 Git 子进程隔离宿主机的命令行配置

Status: implemented

[English](2026-09-27-plugin-manager-git-child-environment.md) | 中文

## Problem

自托管 Windows 串行 lane 在运行 36227311113（作业 108363684565）中失败 13 个用例，其中 12 个同一成因：[github-connection.spec.ts](../../../../packages/boot/plugin-manager/tests/github-connection.spec.ts) 9 个（六种安装地址形式与三个代理用例）与 [manager.spec.ts](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) 3 个真实 Git 安装用例。该宿主机携带 Git 的索引式命令行配置——`GIT_CONFIG_COUNT` 加上 `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`，即 Git 交给 `git -c` 调用及其 hook 子进程的那一组变量。共享的子进程清洗（`scrubbedParentEnv`）按凭据形态的名字移除变量，于是移除了键却保留了计数；Git 先读计数，每个子进程都在打开任何配置文件之前以 `error: missing config key GIT_CONFIG_KEY_0` / `fatal: unable to parse command-line config`（退出码 128）失败。

## Decision

这两个 spec 文件在派生 Git 之前，从自身进程环境里删除 Git 的命令行配置组，由 [isolateGitCommandLineConfig](../../../../packages/boot/plugin-manager/tests/git-environment.ts) 完成。这些 spec 判定的是 profile 行为——profile 的 Git 配置、真实安装——而不是宿主机状态，因此导出该组的宿主机不再改变它们的结果。辅助函数在文件结束后用 `vi.stubEnv(name, undefined)` 与 `vi.unstubAllEnvs()` 还原被移除的条目。

## Alternatives considered

**在 `scrubbedParentEnv` 中整体移除该组。** 产品侧修复把计数与它的键当作一个整体，但它会改变所有消费者共享的子进程行为，而本次改动的 review 指令排除了这一点。该修复保留在分支 `deferred/git-command-line-config-scrub-20260927`，留待将来带自身论证的产品 PR。

**在 plugin-manager 的调用点固定 `GIT_CONFIG_COUNT: '0'`。** `packages/deliverables/workspace-changes/src/git.ts` 正是这样对待自己的子进程，因此在 `github-connection.ts` 与 `operations.ts` 加同样两行即可覆盖这一类。但那仍属产品行为改动，故不在此范围内。

**在 lane 的工作流里清除该组。** 该组来自宿主机镜像，而不是本仓库拥有的某个步骤，且其他会派生 Git 的 spec 仍会暴露。

## Verification

`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=true pnpm exec vitest run packages/boot/plugin-manager/tests/github-connection.spec.ts packages/boot/plugin-manager/tests/manager.spec.ts` 在父修订上以 lane 的断言集合失败 12 个用例，加入隔离后 95/95 通过。

## Consequences

这两个 spec 在导出 Git 命令行配置的宿主机上通过。产品对此类宿主机的处理未变，因此同一环境仍会破坏共享清洗的其他消费者；将来若改动 `scrubbedParentEnv`，必须回头审视本记录。
