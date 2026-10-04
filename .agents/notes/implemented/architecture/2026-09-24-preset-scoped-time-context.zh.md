# Agent Note: 按 preset 归属的时间上下文

Status: implemented

[English](2026-09-24-preset-scoped-time-context.md) | 中文

## Problem

`packages/bundle/web-app/cordis.patch.yml` 中的一行会服务于 profile 中的每个 preset，因此把 `time-context` 行放在那里，会为每个 preset（包括 `minimal`）的每个符合条件的步骤追加一条 user 角色消息。`minimal` preset 只组合 persona 与 persistent shell：它不声明提醒工具，其中也没有任何东西会把该读数变成定时目标，因此那条消息在它的组合中没有消费者。

## Decision

`packages/bundle/web-app/presets/standard.patch.yml`、`ptc.patch.yml` 与 `cordis.patch.yml` 各自在其 Agent 上下文行中声明 `time-context`；`minimal.patch.yml` 不声明。`packages/bundle/web-app/cordis.patch.yml` 不含 `time-context` 行；它插入 `schedule` 与 `ui-schedule`。`packages/bundle/web-app/package.json` 继续声明 `@deepseek-ai/dsh-time-context`，这是 `verify-cordis-config` 对 `presets/cordis.patch.yml` 贡献的裸包名的要求。

这里确立的边界是：携带时间的注入归属于消费它的 preset。由 preset 决定其 Agent 是否收到时钟读数，因此该读数与消费它的提醒工具同行；`schedule` 宿主服务行与 `ui-schedule` 客户端行是与 preset 无关的界面，因此由 [Web bundle](../../../../packages/bundle/web-app/README.zh.md)为整个部署插入它们。该组合负责 `web` profile 挂载哪些宿主行与客户端界面；本记录负责该读数的 preset 归属。

插件本身没有改动：它仍按配置的最小间隔追加采样瞬时、附加到当前开放请求的浏览器时区，以及自前一条模型可见消息以来的经过时长。

## Alternatives considered

**把该行留在宿主行列表。** 这样 `minimal` 会继续收到其组合中无任何消费者使用的模型可见消息，与把提醒工具改为 preset 声明所依据的规则相矛盾（[按 preset 提供的 Schedule 工具](2026-09-24-preset-scoped-schedule-tools.zh.md)）。

**在 `minimal` 中也声明该行。** 这会让各 preset 的归属看起来一致，但会在能力贫乏的组合中保留同一条无人使用的持久消息，因此它仍要付出本改动所消除的成本。

**把时钟交给 Schedule 宿主服务。** 该服务校验带偏移量的 `at` 值或显式 `time_zone`；它不读取浏览器、Session、进程或模型上下文，读数只作为提示词内容到达模型。因此宿主服务行不需要该注入，把时钟采样搬进存储也会把两个各自独立归属的决策耦合起来。

## Consequences

- `minimal` 会话不再追加 time-context 消息，其模型收不到时钟读数，因此用户未明确限定的任何日期或时间都必须询问。
- `standard`、`cordis` 与 `ptc` 会话保持发布版的 10 分钟最小间隔读数，且四个提醒工具仍留在这三个 preset 中。
- 读数对模型可见且持久，因此它参与回放、压缩并出现在导出的 Session 日志中；`snapshots/web/minimal-preset/session.v4.jsonl` 不再记录它。
- profile patch 层无法按 id 禁用或改配该行：`applyEntryPatches` 只能触达已加载的条目或某个 group 的子项，而 preset 声明的插件位于 preset 行的 `config.plugins` 内。改动该行意味着重述该行，这也是 Web 编辑器保存 preset 编辑的机制。
- preset 挂载会覆盖该 preset 的子 agent，因此 `standard`、`cordis` 或 `ptc` 的子 agent 会收到与其父级相同的读数；这些 preset 中的提醒工具仍对该子 agent 保持 deny，并拒绝其调用。

## Testing

`apps/web/tests/schedule-after.e2e.ts` 固化随发行版交付的组合：`schedule` 与 `ui-schedule` 两行，`time-context`（`@deepseek-ai/dsh-time-context`）与 `tool-schedule`（`@deepseek-ai/dsh-tool-schedule`）在 `standard`、`ptc` 与 `cordis` preset 中各声明一次且未禁用，也不在 `minimal` 中，且不含 `time-context` 行。其每步读数 overlay 通过重述 `preset-standard` 声明的插件实现，而不是按 id patch 该行。`apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts` 断言随发行版交付的组合含 `schedule` 与 `ui-schedule` 条目，且不含 `time-context` 条目。
