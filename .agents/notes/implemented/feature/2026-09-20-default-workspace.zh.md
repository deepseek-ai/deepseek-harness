# Agent Note: 首次使用默认 Workspace

Status: implemented

[English](2026-09-20-default-workspace.md) | 中文

## Problem

新安装的应用要求用户先选目录才能发送第一条消息。去掉这一步前置操作时，必须保留 Session 的固定工作目录，也不能把隐藏或已归档的历史误判为新安装。

## Decision

启动时等待完整的 Workspace 和 Session 基线。两份列表均为空时，Client 请求 Host 准备默认 Workspace，随后创建或复用并选中其空白 Session。Session 存在前不可输入，之后使用常规 composer 流程。[Session scope 与供给通道](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md)负责 blank Session 复用与供给通道的理由。

[Workspace registry](../../../../packages/workspace/workspace/README.zh.md#first-use-workspace)负责资格判断和目录准备。所有 live Session、持久化 header 和已归档身份都计入判断，包括侧栏中不可见的条目。操作共用 registry 修改队列，并在目录准备后重新检查 Session 历史，因为 Session 可以独立启动。

Host 控制器解析 Documents 位置；注册表接收不依赖 locale 的目录解析器。解析器仅在允许创建时于变更队列内运行，因此重复请求直接复用持久化的 Workspace，无需再次查询操作系统目录。持久化 Workspace id 独立于名称记录初始化成功。改名、切换语言、重启或删除登记均不能再次初始化默认工作区。标记与登记一起提交，因此登记失败可以重试。目录内容仍遵循已有的[仅删除元数据策略](2026-07-27-workspace-registration-deletion.zh.md)。

本决策中与命名相关的部分已被取代：[语言中立的默认工作区命名](2026-09-23-language-neutral-default-workspace-naming.zh.md)固定目录名与存储标题，只本地化屏幕上的标签。

不符合首次使用条件时不返回 Workspace，也不显示失败弹窗。准备失败时提供现有文件夹选择器；后续列表通知不会触发启动流程重试。成功的登记会在 Session 创建或提示词发送失败后保留。选中默认或手动选择的 Workspace 均不会提交消息。

## Alternatives considered

- 仅在发送时创建可以避免未使用的目录，但需要独立的本地草稿、向 Session 转移草稿及首次提交协调逻辑。启动时创建接受提前写入文件系统的副作用，始终使用普通 Session 输入。
- 系统查询不可用时回退到 `<home>/Documents`，会选择未经确认的 Documents 位置；需要其他目录的部署使用显式 Host 覆盖配置。
- 根据侧栏可见行推断首次使用，会忽略已归档、隐藏和无 cwd 的 Session。
- 将初始化目录的路径作为初始化标记，会允许改名、迁移或删除后再次创建默认工作区。
- 在 Session 创建后更改 cwd，会改变其已记录工具和附件的含义。

## Consequences

打开新安装的应用即可在用户发送消息前创建目录和空白 Session。目录授权与准备失败提示可能在启动期间出现。Desktop 和远程 Web 客户端均由 Host 准备目录，因此远程用户使用 Host 账户的 Documents 位置。Documents 查询不可用时，采用与目录创建失败相同的文件夹选择恢复路径。

该功能保留[由引用持有的 Client Session 生命周期](../architecture/2026-09-15-client-session-references.zh.md)，无需修改 agent-loop 或 Session 事件。Registry 和客户端测试覆盖重试、隐藏历史、并发及启动取消；[浏览器场景](../../../../apps/web/tests/default-workspace.e2e.ts)通过隔离的 Documents 目录和已录制 Session 回放验证完整装配下的启动、刷新、首次发送与选择器路径。
