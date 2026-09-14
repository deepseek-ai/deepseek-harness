# Agent Note: Issue 策略模块归属

Status: implemented

[English](2026-09-07-issue-policy-module-ownership.md) | 中文

## 问题

Issue 校验与 Project 生命周期处理使用相同的引用解析器、元数据规则和 GitHub 读取，但各自作出不同决策、执行不同写入。将这些职责放在命令入口中，会使复用策略规则时更难摆脱对事件分派与输出处理的依赖。

## 决策

Issue 管理将纯决策、GitHub 访问、PR（Pull Request）求值、生命周期 mutation 和命令分派分配给各自的所属模块。[所属参考文档](../../../../.github/issue-management/README.zh.md#module-ownership)将这些职责对应到源文件。调用方和测试直接导入拥有该操作的模块，不把命令入口用作导出集合。

此职责分离保留策略结果、诊断、凭据、API 请求、生命周期 mutation 和工作流入口命令。[选择性求值](2026-09-07-selective-issue-policy-evaluation.zh.md)仍独立拥有强制范围、Project 读取选择和事件调度规则；本决策不重新定义这些行为。

## 考虑过的替代方案

**保留单一命令模块。** 单文件可以避免本地所属模块之间的导入，但会把可复用的决策与 GitHub 访问绑定到命令处理。独立的所属模块让 PR 校验和生命周期处理可以共享既有规则与读取，而无需共享命令分派。

## 影响

维护者可以按职责定位规则、网络操作或事件处理器。复用通过普通的本地 ESM 导入完成，而不是新增包或插件 API。新增模块引入的导入关系需要在共享函数变更时同步维护。

模块分离不会授予更强的凭据、更改检查权威来源、串行化 Project mutation，也不能防止未来的行为回归。既有生命周期竞态与字段管理限制仍由各自的行为文档记录。

## 验证

[策略测试](../../../../.github/issue-management/policy.test.mjs)运行所属模块，并检查可观察的策略与生命周期行为。[工作流测试](../../../../scripts/ci-workflow.spec.ts)覆盖命令接线与工作流声明。这些证据针对被检查的实现，不保证后续编辑仍保留行为。
