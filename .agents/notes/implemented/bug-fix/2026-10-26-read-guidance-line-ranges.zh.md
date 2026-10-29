# Agent Note: read 指导点名 shell 读取命令与行区间

Status: implemented

[English](2026-10-26-read-guidance-line-ranges.md) | 中文

## 问题

read 指导只把 `cat` 点名为 read 工具替代的 shell 命令，并把 `offset`/`limit` 描述成继续读大文件，而不是读行区间。#6057 记录了一个长 Session 用 `sed -n X,Yp` 读行区间 60 次。#6054 增加了 `sed`、`head`、`tail` 和行区间措辞；后来的一次提示词回退把它们和不相关的改动一起删掉了。

2026-10-23 对 SDK profile（native 工具、六个 benchmark）的评测里，这句是唯一改动：相对 base commit，Pass@1 均值 −0.03pp、Pass@3 均值 +0.70pp（该均值取报告 Pass@3 的五个 benchmark；ProgramBench-New 没有 Pass@3），步数与 token 变化方向不一（ProgramBench-New −15.5 步、Terminal-Bench-v4 +13.5 步）。PTC 模式的运行没有包含这个变体；只要 `read` 可见，这段就会进入每个请求。

## 决策

逐字恢复 #6054 的措辞：`Use the read tool — not shell commands like cat, sed, head, or tail — to inspect text files. Use offset and limit to read a line range or continue a large file.` read 工具及其指导归 `@deepseek-ai/dsh-tool-fs` 所有；write 与 edit 的指导不变。

## 考虑过的替代方案

**只依赖 read 工具 schema。** schema 已经写明 `offset` 与 `limit`，但 #6057 显示在那个 schema 存在时模型仍选择 `sed`；指导是唯一点名 `sed`、`head`、`tail` 的模型可见位置。

**把与这句一起被回退的所有提示词都恢复。** subagent 结束本轮句、`run_code` 参数顺序、PTC 语法归属、SDK persona 是各自独立的决定；第一项已经恢复（[subagent 结束本轮 note](2026-10-21-subagent-end-turn-guidance.zh.md)），其余各有自己的证据。

**只说“行区间”，不点名 shell 命令。** 观测到的失败就是模型选择 shell 命令，所以这句点名它们。

## 验证

- `packages/fs/tool-fs/tests/tools.spec.ts` 断言渲染出的指导文本。
- 所有渲染 read 指导的 `system-prompt*.expected.md` sidecar 都带有恢复后的句子：`test:snapshot` 回放 session 与 SDK 集合，`pnpm run test:web:ci` 回放 `snapshots/web` 集合（`node 24 / snapshots and artifacts` lane 两条都跑）。两个显式 pin 的历史 sidecar（`web/cordis-tool-round`、`web/schedule-catalog`）保留录制文本。
- 上面的评测在 native SDK profile 上只改了这一句进行测量。

## 影响

- 只要 read 工具存在，每个请求多三个命令名和一句行区间说明，约 10 token。
- 模型读行区间时被引导到 read 工具，而不是 `cat`、`sed`、`head`、`tail`。
- benchmark 上这句测得为中性；保留它依据的是 #6057 的生产观测，而不是测到的质量收益。
