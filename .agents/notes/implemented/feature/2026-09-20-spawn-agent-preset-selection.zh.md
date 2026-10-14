# Agent Note: 独立 spawn preset 选择与恢复

Status: implemented

[English](2026-09-20-spawn-agent-preset-selection.md) | 中文

## 问题

spawn 子 Agent 需要可复用的 persona、工具和技能组合，同时保留[隐式加入父方 preset](../../archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.md) 的行为。恢复时必须区分独立选择与历史子会话日志，不改变 Session 格式或 fork 行为。

## 决策

显式指定 spawn preset id 时解析当前注册的定义，即使该 id 与父方相同；省略时加入父方正在运行的确切代际。选择具名配置意味着接受当前声明及其解析失败；继承活跃组装则保留它的插件实例，即使声明已经修改或移除。

独立选择的子 Agent 在首条自有 `subagent/descriptor` 之前记录已有的 `agent-preset/selected` 事件。冷恢复排除继承的 fork 前缀，用此顺序识别独立选择，再从已有 `agentPreset` 投影读取所选 id。投影缺失时拒绝恢复，避免静默切换到父方组装。

不具备此顺序的历史子会话继续隐式加入父方。创建 header 可能包含继承的 preset id，fork 种子可能包含祖先的选择，旧子会话也可能在 descriptor 之后记录选择；这些事实都不能证明子会话创建时作过独立选择。事件顺序标记保留这些历史语义，无须增加 descriptor 字段或新的事件类型。

## 考虑过的替代方案

**所有子 Agent 都按 preset id 解析。** 这会让省略选择的子 Agent 读到更新后的定义，或因定义移除而失败，改变隐式加入及历史恢复行为。

**仅从 header 或投影推断独立选择。** 两者都可能携带继承值。末值投影还会丢失事件顺序，无法区分创建时选择与历史日志中的后续选择。

**在新版本 descriptor 中存储 preset id。** 已有选择事件和投影已经持久化该 id。增加字段会重复存储，并为现有事件顺序已能表达的区别引入 descriptor 迁移。

**支持嵌套 preset 对象。** 第二种配置写法会增加优先级与校验规则，却不服务于现有调用方。扁平的 preset id 选择组装；fork 不接受独立 preset 选择。

## 后果

独立恢复按所选 id 解析已注册定义，不跨重启保存历史代际。preset 缺失或无效时明确失败。隐式子 Agent 与 fork 保留原有组装和冷恢复行为。

针对性 continuation 测试覆盖事件顺序、继承前缀、历史日志和缺失投影。会话录制快照通过 shipped headless 组装覆盖独立 persona 与工具选择。
