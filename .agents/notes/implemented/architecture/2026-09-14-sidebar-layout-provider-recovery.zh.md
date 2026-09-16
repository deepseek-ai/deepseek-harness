# Agent Note: 侧栏布局持久化与 provider 恢复

Status: implemented

[English](2026-09-14-sidebar-layout-provider-recovery.md) | 中文

## Problem

刷新浏览器会丢失已打开文件、分栏位置和选中项。把保留的终端重新打开为新标签无法还原布局，还可能展开原本折叠的侧栏。

## Decision

侧栏按 Session 持久化经过校验的当前布局快照和身份计数，Client store 将撤销历史保留在内存中。保存的类型或布局引用无效时，只清理对应 Session 的快照。刷新后撤销历史清空，因此持久化数据不会随过去的操作持续增长。它在渲染正文前恢复布局和标签身份，并建立资源 pin。provider 恢复自身内容；侧栏不保存终端专属状态，也不负责重连。临时导航参数和资源内容不进入布局快照。

terminal provider 读取已采用的 Session 标签记录，先恢复终端模型，再查询尚无视图的 Host 终端。其 Client controller 在分配前将全局唯一内容与终端身份的关联保存为独立记录，刷新后复用，并在记录显式关闭意图后删除。布局内的 tab id 标识独立活动视图，不能跨窗口标识持久化进程；逐条记录的写入和删除避免覆盖无关关联。恢复身份不允许创建替代进程。Host 负责进程存活状态、标题和屏幕内容；保存的关联只是恢复目标。没有对应恢复标签的关联不会阻止 Host 探测。

OpenCode 的 `packages/app/src/context/layout.tsx` 保存 Session 标签，`context/terminal.tsx` 独立保存终端身份。DSH 使用现有 Session 作用域 store 和 provider 服务实现相同的职责划分，终端仍归 Session 所有。

本决策部分替代 [Web 终端决策](../feature/2026-09-09-web-sidebar-terminal.zh.md)中不持久化的限定。原记录继续保留，因为进程归属、清理、流传输和输入控制决策仍适用。

## Alternatives considered

**把每个保留终端恢复为新标签。** Host 探测无法还原标签位置、选中项或折叠布局，还会重复创建已恢复的标签。

**让侧栏负责终端恢复。** 布局所有者会因此依赖特定内容 provider。提供通用的已提交标签查询即可让各 provider 恢复自身状态。

**持久化进程元数据和终端输出。** 这些值会独立于浏览器布局失效。重新连接 Host 能取得当前元数据和一致的屏幕。

## Consequences

同一浏览器站点内刷新会保留布局，各 Session 使用独立存储键。窗口共享每个 Session 最后保存的布局；活动窗口在刷新前保留各自布局。存储失败时内存状态仍可用。刷新不会重启缺失或已退出的进程；Host 重启仍无法恢复 shell。provider 状态需要自身支持恢复，临时文件导航参数不恢复。

store 测试覆盖布局读写、有界持久化状态、无效记录、Session 隔离和资源采用。终端测试覆盖身份复用、目标缺失、未激活标签关闭，以及没有恢复标签时的探测。完整浏览器测试使用真实终端进程身份，验证文件预览、分栏、选中项、全屏和折叠状态下的刷新。

[无人连接终端的两小时回收](../feature/2026-09-14-unattended-browser-terminal-reclamation.zh.md)为 provider 恢复增加窗口持有的终端生命周期，保留此处的布局/内容职责划分。
