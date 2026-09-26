# Agent Note: 在随附默认组合中关闭 ralph

Status: implemented

[English](2026-09-12-ralph-off-in-shipped-defaults.md) | 中文

## 问题

`ralph` 工具运行一个固定的前台循环：每一轮开启一个全新的、不带对话种子的子代理，直到某个 worker 报告完成或给出具体阻塞原因才返回。它面向模型的描述把用途限制为直接人类明确要求的场合，其 README 也记录：完成与否是 worker 的自我声明，没有独立评估；该循环没有后台收集、没有可恢复的检查点，也没有调度器。

该工具在 `packages/bundle/base/cordis.patch.yml` 以及四个随附 agent preset 中的三个里默认启用。于是默认会话带着一个自身描述就叫模型不要主动使用的工具，默认档位的工具目录也在宣传 Harness 尚未背书的能力。[随附工具清单](../feature/2026-07-31-even-out-shipped-tool-rosters.zh.md)决策组装了这份 base 清单，并逐条列出此后的每次收窄；本次是那份清单上新增的一条。

## 决策

`packages/bundle/base/cordis.patch.yml` 把它的 `tool-ralph` 行声明为 `disabled: true`，`standard`、`ptc`、`cordis` 三个 preset 也以同样方式声明各自的 `tool-ralph` 行。`minimal` preset 没有该行。包本身、工具的对外约定和它的测试都保留：这次改的是哪些默认组合挂载该行，而不是该能力是否存在。

`ptc` preset 还额外把 `workflow-ptc` 声明为禁用。该 preset 在去掉通用 `workflow` 工具之后只为 `ralph` 保留了这个引擎，因此禁用 `ralph` 使该组合中的引擎不再有消费方。

每个被禁用的行都在本地注释里带上恢复方法。对基于 base 的档位，用一行 overlay 即可从 `$DSH_HOME/cordis.patch.yml` 或 `--patch` 文件重新启用。随附 preset 是 Web bundle 补丁（`packages/bundle/web-app/cordis.patch.yml`）里的 `@deepseek-ai/dsh-agent-preset` 行，因此想要 `ralph` 的 Web 会话可以在 profile 补丁里覆盖该行的 `config.plugins`，或通过 Web 编辑器以**新 id** 保存一个 preset，声明会持久化到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；注册表拒绝重复的 preset id（`packages/preset/agent-preset-registry/src/index.ts`）。在 `ptc` 中，覆盖要同时删掉工具行和引擎行的 `disabled`，因为 `tool-ralph` 注入 `ctx.workflowEngine`。

`packages/bundle/web-app/cordis.patch.yml` 在自己的层里重述这条禁用声明。`scripts/verify-cordis-config.ts` 中的 `validatePresetPlaneSeparation` 在收集已声明的行 id 时不看 `disabled`，所以删掉这一行会让 `tool-ralph` 回到 Web 宿主平面，并与每个 preset 中的同名行冲突。

`snapshots/session/ralph-loop` 成为 `ralph` 组合的所有者，它的 `cordis.yml` 与 `cordis.snapshot.yml` 重新启用该行，于是唯一演练该工具的录制场景保住了自己的证据。兄弟组合不会继承 `text-turn/cordis.snapshot.yml`，因此新的回放补丁在 `ralph` 行之外重述了那些替换项。

## 考虑过的替代方案

**新增第五个随附 preset 承载被降级的能力。** preset 名单提供了真实的按会话选择，但随附 preset 一经存在就会被发现并展示给每个用户，无法表达“默认关闭”。preset 层同样没有补丁语义，新 preset 就是 `standard` 的一份完整副本，会与它静默地分叉。

**删除该行而不是禁用它。** [共享 base 默认文件编辑器](2026-09-05-base-default-file-editor.zh.md)的决策把 `str_replace_editor` 从 base 的选择中移除，而不是关闭随附，也最明确地表达了降级。被删除的行对用户自有组合同样不可达，因为补丁只能对已存在的行翻转 `disabled`。

**只在 Web preset 中降级。** 默认 Web 会话正是讨论中的界面，这样的差异也最小。它会让 headless、sdk、acp 和自定义的基于 base 的档位继续随附默认 Web 界面拒绝的工具，而这正是 `verify-cordis-config` 所称的近似副本漂移的常见失败形态。

**连同 goal 工具一起降级。** 两者都推迟了独立评估，用同一把尺子量结果相同。goal 工具是受支持的长时间工作路径——`ralph` 的描述本身就把普通的长时间工作指向它们——并且带有产品界面，因此一起降级会让长时间工作失去受支持的运行方式。

**在 `ptc` 中保留 `workflow-ptc` 启用。** 这样在复制出的 `ptc` preset 中删掉 `tool-ralph` 的 `disabled` 只需改一处而不是两处。它会在随附组合里留下一个没有消费方的提供方，而 `packages/AGENTS.md` 拒绝这种做法；改由重述后的注释点明这层依赖。

**把选择启用的方法写进 `docs/`。** 指南页面能触达从不打开组合文件的用户。各平面的恢复方法不同，但每种都只有三行，因此由行内注释在使用点承载。

## 后果

默认的 Web、headless、sdk、acp 或自定义基于 base 的会话不再提供 `ralph`，`standard`、`ptc`、`cordis` 三个 preset 也不再提供。要恢复它，用户需要修改组合，因此该能力变成显式选择加入，而不只是被劝阻使用。已经记录了 `ralph` 调用的既有会话仍可回放和渲染：工具包仍然安装，其事件类型未变。

`ptc` 模式同时失去该引擎。复制出的 `ptc` preset 若只恢复 `tool-ralph` 而不恢复 `workflow-ptc`，该工具行会留下未解析的注入，这正是两行都在注释里点明这层依赖的原因。

## 验证

`apps/cli/tests/web-agent-presets.e2e.ts` 固定了四点：每个带 `tool-ralph` 的 preset 都禁用它；`minimal` 清单不含该行；`ptc` 禁用 `workflow-ptc`；`standard` 与 `cordis` 为各自的 `workflow` 工具保留引擎启用。`apps/cli/tests/web-agent-presets.e2e.ts` 与 `apps/web/tests/shipped-composition.e2e.ts` 固定默认与 PTC 的确切工具目录，因此某一行不再贡献会直接导致测试失败，而不是让列表悄悄变短。`scripts/verify-cordis-config.ts` 的平面隔离检查在禁用行存在的情况下继续通过。

多数受影响的录制会话旁挂文件由 `DSH_SNAPSHOT=refresh pnpm run test:snapshot` 重新生成，并由 `pnpm run test:snapshot` 回放整个语料。另有六个旁挂文件是人工整理，因为本机没有任何一次运行会产出它们。其中四个属于 `pwsh-tool-turn` 与 `persistent-pwsh-tool-turn`：本机缺少 `pwsh`，这两个场景在本地被跳过；它们删掉的文本与刷新在别处删掉的文本逐字节相同。剩下两个是 `snapshots/web/schedule-catalog`，没有任何在执行中的测试写入或读取它们：`schedule-after.e2e.ts` 只读该目录的 `catalog.expected.md` 与 `session.v3.jsonl`，`assertFixtureInventory` 也只检查那四个文件存在，因此它 `snapshot.yml` 里的 `header.pin: true` 并未被强制执行。`snapshots/session/ralph-loop` 在它自己的组合补丁下通过，这证明这次降级把该行移出了默认组合，却没有移除对该工具的覆盖。
