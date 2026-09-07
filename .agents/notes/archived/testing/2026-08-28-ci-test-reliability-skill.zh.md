# Agent Note: CI 测试可靠性 Skill

Status: implemented
Archived: 2026-09-04

[English](2026-08-28-ci-test-reliability-skill.md) | 中文

## 问题

DeepSeek Harness 会在并发的 Vitest 文件、worker 进程、仓库 gate 与 Actions job 中运行测试。进程隔离不会隔离宿主机端口、可预测路径、外部命名空间或继承的子进程，而进程全局状态变更与未完成的 teardown 可能污染后续测试。即使测试选择了正确层级，也可能只在独占运行时通过。

测试政策负责测试层级，防御性模式负责运行时生命周期规则，pre-push 指引负责选择命令，代码 review 负责检查已完成的 diff。它们都没有为 agent 提供一个聚焦流程，用于按照真实 CI 拓扑设计会占用资源的测试，或在修改代码前对已有概率性失败进行分类。

## 决策

[dsh-ci-test-reliability](../../../skills/dsh-ci-test-reliability/SKILL.md) 负责测试隔离与 CI 概率性失败诊断指引。测试或 fixture 占用宿主机资源、修改进程全局状态、依赖异步就绪、持有子进程或网络 listener，或出现概率性 CI 失败时，使用该 Skill。

该 Skill 要求 agent 建模单个 Vitest 进程之外的并发，原子分配实时资源，把稳定 fixture 标识与临时传输地址分开，按可观察状态同步，精确恢复全局变更，并等待 teardown 达到静止状态。回归证据与所持有的风险匹配：guard 使用负向控制，竞态使用确定性 barrier，宿主机资源隔离使用并发独立进程，并以外部观察代替组件自述。

另有两条规则覆盖仓库已经付出过代价的失败。操作系统拥有的值不保证按写入的样子返回，因此只有在断言容忍写回失败时，测试才可以把它写回去；断言依赖写回成功时，期望值取自重新读取。以及套件级 timeout 覆盖而不是让位于 runner 的 flag，因此受进程创建约束的套件取 lane 预算、连同 hook 预算一起抬高，并让外层等待远大于任何被测超时。据此，恢复已被授予的预算、或按实测争抢标定一个有界重试，都不属于掩盖式修复。

仅用于诊断的流程放在单独 reference 中，因此普通编写任务不会加载 Actions 分诊步骤。它会先比较成功与失败证据，再对宿主机冲突、未完成生命周期、全局状态污染、负载敏感同步、平台或入口路径失败、产品竞态、provider 瞬时故障或 runner 基础设施进行分类。

[dsh-pre-push-checks](../../../skills/dsh-pre-push-checks/SKILL.md) 在选择命令前按条件引用可靠性 Skill，[dsh-code-review](../../../skills/dsh-code-review/SKILL.md) 则在 review 高风险测试时应用它。命令选择与通用 PR review 仍由这些现有 Skill 负责。

该决策与[确定性与压力测试提案](../../proposed/testing/2026-06-11-deterministic-and-stress-testing.zh.md)部分重合。该 Skill 交付测试编写与诊断指引，但没有实现提案中的 lint 规则、通用回放 fixture 或 nightly stress job，因此提案保持活跃。

## 考虑过的替代方案

**扩展 dsh-pre-push-checks。** Pre-push 指引在测试设计之后运行，负责选择证据。如果它还负责资源分配、同步、teardown 与 CI 诊断，就会混合两种不同决策，并让普通 push 也加载可靠性流程。

**扩展 dsh-code-review。** Review 指引可以在 diff 已存在后发现不可靠测试，但无法在 fixture 设计过程中指导 agent，也无法在没有 PR 时指导故障诊断。

**把完整流程放入常驻测试政策。** 测试政策需要保持为测试层级与放置规则的简洁权威来源。让每个测试任务都加载详细 Actions 诊断与资源专项流程，会重复情境性指引，也会降低政策的可扫描性。

**立即增加通用 stress runner 或正则 gate。** 重复运行保持绿色不能证明竞态已受控，而字面端口、路径、sleep 与 URL 可能是合法的 parser 输入或期望值。未来若出现高信号缺陷类型，可以增加窄范围的可执行检查，而不必把宽泛文本匹配当成政策。

## 后果

Agent 在设计或诊断确实需要这些规则的测试时获得可靠性指引，pre-push 与 review 流程也能共用同一套标准而不复制步骤。纯确定性测试继续采用普通的聚焦证据路径。

该 Skill 属于指导性规则，无法机械阻止所有资源冲突。如果某种缺陷反复出现且能被静态识别，仍可增加可执行的仓库检查。仓库也会多维护一个活跃 Skill 与 reference，其链接和陈述必须与真实 CI 拓扑保持一致。

现有确定性与压力测试提案继续开放，本变更也不会审计或重写当前测试语料库。
