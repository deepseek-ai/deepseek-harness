# Agent Note: 工作区版本一致性是静态门禁

Status: implemented
Archived: 2026-09-04

[English](2026-09-03-workspace-version-coherence-gate.md) | 中文

## 问题

dsh 发布序列在全部可发布成员（`packages/` 非实验成员与 `apps/*`）、每个私有 dsh 包与工作区根之间共享一个版本；`release:dsh` 写出该版本，发布通道的 `verifyVersions` 在可发布成员分歧时失败。常跑的静态通道只为 `packages/*` 执行同一条规则：位于 `apps/` 下的 `@deepseek-ai/dsh-*` 清单，或名字就是 `@deepseek-ai/dsh` 的 CLI 清单，携带共享版本却没有自己的静态检查，只有发布通道的 pack 任务（`release:verify`、`verify-npm-install-layout`）注意到这里的漂移。

2026-09-03 版本失配进入 master 正是这个覆盖缺口。`packages/util/http-proxy` 在家族尚为 `0.1.2-alpha.5` 时被新增，却在家族升到 `0.1.2-rc.1` 之后才合入，其清单仍带 `0.1.2-alpha.5`。`constraints` 在合入后的状态上失败，发布通道的 Dependency layout 与 Pack npm tarballs 任务随之失败，所有基于该坏 master 的 PR 被带红。引入该包的 PR 最后一次 CI 运行早于升版（2026-09-02 13:40，绿色；升版 2026-09-03 03:21 合入，该 PR 于其约两小时后合入），因此每个本可抓住版本问题的门禁都在过期快照上跑出绿色。仓库内没有门禁会在 base 移动时重跑 PR 检查，而 master 也没有要求 base 最新的分支保护。

## 决策

`check-workspace-constraints` 现在拥有覆盖整个家族的版本规则。其 `checkDshFamilyVersion` 划定边界：任何被扫描的工作区清单，名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`，都必须携带工作区根的版本。该测试基于名字而非目录，因此覆盖 `packages/`（可发布与私有/实验成员）、`apps/` 与根清单本身，并让 vendored 框架与 Landlock 序列留在各自的版本线上。原 `packages/` 作用域的比较曾是该规则唯一的静态家园；与它相邻的形态检查（cordis peer/dev 配对、`type`、`main`/`types`/`exports`、发布 `files`）仍限定在 `packages/`。

边界与 `release:dsh` 所写一致：根、可发布成员、以及 `packages/*/*` 下每个私有 dsh 包。因此分歧会让零构建静态通道失败——`ci-static`、`ci-primary` 与 `hygiene` 中的 `constraints`，它们跑在每次 PR 与 master 推送——而不是只在一个新快照的发布通道中浮现。

## 曾考虑的替代方案

**为成员集合导入发布家族对象。** 家族对象的 `members()` 只发现可发布成员，那是发布通道的边界；该不变式还覆盖私有包，静态门禁因此还得再写一遍 bump 脚本的私有包发现。一条名字谓词一次说清整个边界，并无需导入任何发布机制。

**只在发布通道执行该规则。** 该通道本就对成员分歧失败，也抓住了 apps/ 缺口，但它是独立工作流，其运行与其他 PR 检查有同样的快照暴露；共享静态通道只需一次廉价检查，把失败放到标准 PR 面板上，并反过来保护发布通道自身。

**以分支保护设置替代门禁。** 合并前要求 base 最新（或队列合并）才是阻止过期快照回合的机制，仓库级门禁看不到 base 的移动。这是仓库设置，不是本仓库能表达的改动；此门禁关闭的是覆盖这一半，该设置仍是互补的保护。

## 后果

当前每个 dsh 命名清单都携带根版本——截至 2026-09-03 有 252 个清单为 `0.1.2-rc.1`，根亦然——所以强化后的门禁通过现状树。家族内任何清单漂移都会让静态 CI 失败，报错点名清单、根的版本与该清单实际版本。门禁不能阻止过期 base 合入：它只观察其运行被触发时所处的快照，因此让合入后的状态被检查仍要求合入后的状态真正跑过检查，那是分支保护设置的职责。[发布序列笔记](2026-08-10-npm-release-sequences.zh.md) 保留版本方案决策；本笔记记录规则在哪里被强制，以及此前强制留下的窟窿。
