# Agent Note: 可继续 subagent 策略继承——持久化子日志拥有委派时快照

Status: implemented
Archived: 2026-09-04

[English](2026-08-10-continuable-subagent-policy-inheritance.md) | 中文

## 问题

自[进程内策略继承决策](2026-07-25-subagent-policy-inheritance.zh.md)以来，一次性进程内驱动器一直会把父级的沙箱／审批覆盖项注入其子级，但可继续路径从未这样做：`SubagentContinuationManager` 的物化只应用子级组合。默认组合包把两个委派工具都配置为 `backgroundMode: continuable`，因此在默认部署中，每个后台子 agent（智能体）都静默回退到部署默认值：切换到 `danger-full-access` 的父级产出的子 agent 卡在 `workspace-write`，每次工作区外操作都会触发审批提示；父级无人值守的 `'never'` 审批立场也退回为发起提示的行为（[dsh-external/issues#334](https://github.com/dsh-external/issues/issues/334)）。

## 决策

捕获／追加这对函数从一次性驱动器移入该 seam 的共享子 agent 模块（`dsh-subagent/src/child-agent.ts`），即声明的共享子级组合唯一归属之处：`captureDelegatedPolicyOverrides(parent)` 通过可选的 `ctx.get` 对 `sandboxPolicy.overrideOf(parent.session)` 建立快照，并把子级审批策略钉定为 `'never'`（[审批钉定决策](2026-08-10-subagent-approval-pinned-never.zh.md)），`appendDelegatedPolicyOverrides(childSession, overrides)` 则追加 `source: 'delegation'` 事件。一次性驱动器与继续执行管理器都调用它们，因此两条路径不会出现偏差。

`startContinuable` 在其第一次 await（`prepareContinuable`）之前完成捕获，沿用与一次性路径相同的「父级后续切换属于父级的未来」边界。快照放在 `MaterializeInputs.create` 中传递，因此只有全新物化会在未发布的设置阶段、排在任何 fork 种子之后追加这些事件。冷恢复（cold resume）不传入 `create` 输入，也不追加任何内容：持久化的子日志已经携带委派事件，而回放该日志本身就是状态。子 agent 的生效策略由持久化子日志拥有，而不是当前 Activation，也不是发起恢复的父级，因此父级在驻留纪元（residency epoch）之间的切换绝不会追溯性地改变一个持久化子 agent。

## 考虑过的替代方案

- **一项通用 child 设置贡献**：不予采纳。贡献只接收子级上下文，因此无法在委派边界捕获父级的覆盖项；在冷恢复与全新创建时都应用它会导致重复追加或重复捕获；而且没有任何机制把它的捕获绑定到 start 调用的同步前缀，await 前捕获的保证会因此丢失。
- **在冷恢复时重新捕获父级覆盖项**：不予采纳。恢复的子 agent 会随父级后续切换静默改变策略，这会破坏委派时快照的语义，并让生效策略取决于恢复时机而非子级自身的日志。希望恢复的子 agent 采用新策略的父级应重新委派。
- **让继续执行管理器导入一次性驱动器的内联逻辑**：不予采纳。Service Definition 包不能依赖自己的提供方包，而在 `continuation.ts` 中复制捕获／追加这对函数会招致偏差；`child-agent.ts` 已经承载其余每个共享组合步骤。
- **把这些事件写入描述符种子轮次**：不予采纳。种子为每个调用方组装时，捕获值尚不可知；而且一次性路径的先例已经确立：在未发布的设置阶段追加，才是把继承事实排在 fork 历史之后、同时保持 `firstLiveSeq` 不变的顺序。

## 后果

- 默认组合包的后台委派（`backgroundMode: continuable`）现在会继承父级显式的沙箱覆盖项，并把子级钉定为 `'never'` 审批；未组合任一策略服务的组合保持原有行为。
- `dsh-subagent` 新增针对 `dsh-sandbox-policy` 与 `dsh-user-approval` 的可选 peer 类型（即一次性驱动器所用的 `ctx.get` 模式）；`dsh-subagent-in-process-driver` 完全移除自己的策略服务 peer 与类型导入，委托给共享辅助函数。
- 可继续测试套件（`packages/subagent/subagent/tests/continuation-inheritance.spec.ts`）锁定全新启动的种子写入、await 前捕获、默认值省略、冷恢复快照稳定性与 fork 种子优先级；ACP 快照场景 `subagent-continuable-inheritance` 经组装后的应用锁定子级的委派事件与只读运行时上下文，移除捕获时即失败。
- 进程外提供方（`acp`、`dsh-sdk`、`claude-code`、`codex`）不支持可继续子 agent（没有 `prepareContinuable`），其一次性子 agent 保留自身的部署策略（`inheritsParentContext = false`）；跨进程策略传播仍不在范围内。
