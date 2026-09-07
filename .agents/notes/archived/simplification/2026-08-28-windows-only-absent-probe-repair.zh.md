# Agent Note: 缺失探测的父目录修复只在 Windows 上执行

Status: implemented
Archived: 2026-09-04

[English](2026-08-28-windows-only-absent-probe-repair.md) | 中文

## Problem

`JsonlSessionPersistence.exists` 把 ENOENT 视为「不存在」，并在返回 false 之前 stat 一次路径的父目录，好让「被普通文件挡住的会话目录」暴露成存储故障，而不是一个不存在的会话。Windows 需要这一步：它对 `regular-file/child` 报的是 ENOENT 而不是 ENOTDIR。POSIX 不需要——`open(2)` 规定路径前缀中有非目录组件时报 ENOTDIR，这一点该修复自己的守卫注释早已写明。

而这次 stat 在所有平台、每一次缺失探测上都会执行。`findLog` 对每个 project 目录发四次探测——两次拒绝 legacy 扁平文件布局、一次查相反编码、一次查日志本身——而 coordinator 每次 `inspect` 要解析两遍 id：一遍在 `prepareCore`，一遍在 `isPreparedSourceCurrent`，后者即使 prepared source 已缓存也照跑。除拥有该会话的那个目录外，其余全部回答「不存在」，所以几乎每次探测都付了这次多余的 stat。

## Decision

该修复现在只在 `process.platform === 'win32'` 下可达，与 `materialize` 既有的平台分派写法一致。POSIX 保留 `open` 自己报出的 ENOTDIR。

## Testing

借用测试套件既有的模块 mock 统计 `node:fs/promises` 调用，对照一个五 project 目录的存储——即真实 `~/.dsh/sessions` 的布局：

| 操作 | 改动前 | 改动后 |
|---|---|---|
| `load` 一个已存在的会话 | 40 open + 41 stat | 40 open + 3 stat |
| `load` 一个不存在的 id | 20 open + 20 stat | 20 open + 0 stat |

该包的 242 个测试原样通过，单文件覆盖率不变；新增分支带的 `v8 ignore` 标记与相邻的平台分派一致。

「POSIX 永远到不了这处修复」是直接验证的，而非采信注释：在 macOS 上打开 `regular-file/child` 与 `regular-file/child/deeper` 都报 ENOTDIR，只有真正缺失的目录才报 ENOENT。

## Alternatives considered

**所有平台都保留这次 stat，作为纵深防御。** 否决：在 POSIX 上它只能确认 `open` 已经报出的结论，检测不到任何调用方本会漏掉的故障——代价是把每次缺失探测的系统调用翻倍，只为重新推导一个已知答案。

**直接删掉该修复，让 Windows 报「不存在」。** 否决：它的存在正是为了让「被普通文件挡住的会话目录」保持为存储故障，而不是读成一个不存在的会话，这与该 backend 别处一贯的 fail-loud 立场一致。

## Consequences

路径解析在 `open` 调用上的开销原样保留：每次查找每个 project 目录四次，每次 `inspect` 两轮。本次只削掉了 stat 那一半，剩余开销仍随 project 目录数增长，而不随会话数增长。

要压掉这轮扫描需要一份 id→path 索引，而它首先要求决定：`rejects a compressed obsolete flat-file artifact during targeted lookup` 钉住的那条「每次查找都做的 legacy 产物守卫」该如何安置。该测试是在 `list()` 已经记忆化 root 编码检查之后才写入产物的，所以这条守卫覆盖的是记忆化之后的存储变动，而索引命中会在到达它之前就返回。「每个 project 目录一次 `readdir`」本可以同时提供 id→path 映射和这条守卫且无需缓存，但实测并不比本次改动更快，所以更进一步的收益必然要引入记忆化及其失效处理。
