# Agent Note: 源码 checkout 路径不定义工作目录

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-source-checkout-workdir-distinction.md) | 中文

## 问题

`harness:source` 提示词段遵循[源码位置决策](../../archived/feature/2026-07-21-dsh-system-prompt-source-path.md)，但原有措辞把 checkout 称为「你自己的源代码」，却没有区分该路径与会话 workspace。在 persona 不声明 `{{cwd}}` 的普通 TUI 配置中，这可能是系统提示词开头附近唯一固定的绝对路径。因此，DeepSeek V4 可能会直接用 harness checkout 回答「what's the workdir?」，而不是确定会话的当前工作目录。

直接断言 checkout 不是工作目录同样不准确。`dsh meta` 会有意让源码 checkout 同时充当这两个值。

## 决策

该提示词段将路径标识为「DeepSeek Harness implementation checkout」。它说明 checkout 位置与当前工作目录是两个可能不同的值，禁止从 checkout 路径推断工作目录，指示模型使用 `pwd`，并限定该 checkout 只用于检查或扩展 DSH 自身。

路径推导方式与全局 `harness:source` 所有权保持不变。该段使用 first-party 顺序 −900，紧随 `harness:identity`。将两者描述为概念上独立、而不是始终不相等，使这条指令在普通项目会话和 `dsh meta` 中都准确。

## 验证

`dsh-app-boot` 单元测试固定了完整文本及其顺序。CLI（命令行界面）无密钥 PTY 冒烟测试检查组装后的请求 header。TUI 的 `source-checkout-workdir` 快照把该提示词段挂载为 `/opt/dsh-source`，通过录制的 DeepSeek V4 turn 提问「what's the workdir?」，并要求回放 transcript（文本记录）运行 `pwd`，报告生成的 workspace 而不是 checkout。

## 考虑过的替代方案

**声明 checkout 永远不是工作目录。**拒绝：`dsh meta` 会有意让它们指向同一路径。

**把当前工作目录写入全局源码提示词段。**拒绝：源码提示词段由 launcher 全局持有，而工作目录属于各个会话；将两者合并会与 agent loop（智能体循环）对 `cwd` 的所有权重复，还会让稳定的源码事实随 agent 变化。

**从提示词中删除源码路径。**拒绝：launcher 从无关项目启动时，自引用 DSH 工具仍需要可靠的 checkout 位置。

## 后果

提示词会变长，直接询问工作目录时可能多花一次廉价的 `pwd` 工具调用。作为交换，模型不再把 harness 实现路径当作隐含的任务 workspace；当 meta 模式使两个值重合时，提示词仍然准确。
