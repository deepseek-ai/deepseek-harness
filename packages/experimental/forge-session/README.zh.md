---
description: "把变更请求绑定到创建、推送或跟踪它们的 Session，并监听其状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-session

[English](README.md) | 中文

## 概述

无需单独的登记簿，即可列出一个 Session 正在处理的 pull request。一个投影从 Session 自己的 `gh pr create`、`gh pr view`、`gh pr edit`、`gh pr checkout` 与 `git push` shell 结果以及绑定记录派生绑定。每次推送后，以及 forge 面板等调用方报告 Session 所在的分支时，服务为该分支查找打开状态的变更请求（change request，即 pull request 或 merge request），并记录尚未绑定的那些。监听一个 Session 时，会通过 `ctx.forge` 轮询其已绑定的变更请求。Session 摘要把绑定带给客户端。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将服务与 forge 注册表、一个提供方以及 Session 投影注册表一起挂载。

```yaml
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
- name: '@deepseek-ai/dsh-experimental-forge-session'
```

`ctx.forgeSession.changeRequests(session)` 按首次记录的顺序返回可见的绑定。每一项包含 URL、其 `origin`（`created`、`referenced`、`discovered` 或 `tracked`）、提供方引用（没有提供方服务该 URL 时为 `null`）以及最近一次轮询结果（尚无结果时为 `null`）。`watch(session, listener)` 是调用方 fiber 上的 effect：Session 有监听方期间，提供方服务的每个可见绑定都会被轮询；此后每次绑定变化、提供方注册变化或轮询结果到达时，监听方都会收到完整列表。提供方变化会重新同步已有监听，包括此前没有提供方服务的 URL。`track(session, url)` 以提供方的规范形式绑定 URL，或恢复已隐藏的绑定；没有提供方识别该 URL 时抛错。`dismiss(session, url)` 隐藏一个可见绑定；其他 URL 不会改变日志。`discoverBranch(session, remote, branch)` 为位于 `remote` 远端的分支执行推送之后的那次查找，记录完绑定或失败后 resolve；没有提供方服务的远端不会带来任何变化。

`bash` 或 `pwsh` 调用只从其第一个结果中提取证据，且仅当工具执行本身成功时才提取；命令的退出状态不影响结果。包含 `gh pr create` 或 `gh pr new` 的命令会绑定其文本输出中的每个 `/pull/<number>` URL。包含 `gh pr view`、`gh pr edit` 或 `gh pr checkout` 的命令以 `referenced` 绑定：命令选中的 `/pull/<number>` URL，或带有明确仓库和主机的数字编号，以及输出为它所操作的变更请求本身打印的 URL，即 gh 的 `url:` 字段、开始描述正文的 `--` 行之前单独成行的 URL，以及 JSON 的 `url` 成员。描述正文或其他字段里的链接不会绑定；同一命令里还包含 `gh pr create` 时，其 URL 以 `created` 绑定。包含 `git push` 的命令（可带前置的 `-C`、`-c` 或 Git 长选项）会记录 `To <remote>` 行下列出的每个已创建、已更新、已强制推送或已是最新的分支；被拒绝、已删除的引用、新标签，以及明确位于 `refs/heads/` 之外的引用会被跳过。对远端由提供方服务的每个被推送分支，服务在 `discoveryTimeoutMs` 内调用 `ctx.forge.findByHead`，并为返回的每个尚未绑定的变更请求追加一条 `discover` 记录。已隐藏的绑定仍视为已绑定而被跳过；只有 `track` 会恢复它们。每次推送都会重新查找；失败记录为警告日志。关闭 Session 会取消其未完成的分支查找，不追加绑定。重新打开不会补做这些查找；可再次推送、调用 `discoverBranch` 或用 `track` 绑定变更请求。仅在协议、大小写、查询、片段或末尾斜杠上不同的 URL 指向同一个绑定。

`gh pr view`、`edit` 和 `checkout` 的数字编号支持 `--repo OWNER/REPO`、`--repo=OWNER/REPO` 和 `-R OWNER/REPO`，参数可位于编号前后。仓库参数中的主机或字面量 `GH_HOST` 赋值可直接确定 URL；对于单条命令（可通过管道传给 `head`、`tail` 或 `cat`），未写明主机且已完成的前台 Bash 调用会通过相同的 shell 服务、工作目录、字面量环境赋值、托管环境和常设沙箱策略，执行只读的 `gh pr view <number> --repo <repository> --json url` 查询，由 CLI 解析其配置的主机。查询成功后追加 `reference` 绑定记录；失败时保留现有绑定并记录警告。此实时观察器需要 `tools`、`shell` 和 `shellEnv`，仅含投影的组合仍可恢复已记录的 URL。查询共用 `discoveryTimeoutMs`，调用方取消会停止查询，销毁服务会中止并等待查询结束。

绑定操作是 `plugin:forge-session/binding` 插件记录，列于[实验性持久化目录](../../../docs/experimental-persistence-catalog.zh.md)；fork 与恢复会把它们与 shell 事件一同带上，因此 fork 出的 Session 从父 Session 的绑定开始。`discoveryTimeoutMs` 见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-forge-session)。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`forgeChangeRequests` 投影保存等待第一个结果的 shell 调用、每个绑定及其隐藏状态，以及每个被推送分支和最近一次报告它的结果的序号。`turn/end` 会丢弃仍在等待的调用。它的客户端视图随 Session 摘要下发，按首次记录的顺序列出每个绑定的 URL、来源与隐藏状态；只有等待中的调用或推送变化时，视图保持同一引用。服务收到 `tool/result` 事件时，只对序号等于该事件序号的推送执行发现，并在绑定数组变化时刷新监听方。销毁服务会中止查找并丢弃其结果。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 发现、track 与 dismiss 记录以及 Session 监听 |
| [`src/projection.ts`](src/projection.ts) | 折叠 shell 调用、结果与绑定记录 |
| [`src/commands.ts`](src/commands.ts) | 命令分类与输出解析 |
| [`src/types.ts`](src/types.ts) | 绑定记录、投影状态与条目类型 |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Forge 子系统](../../../docs/subsystems/forge.zh.md)——变更请求类型与服务参考。
- [Forge 注册表](../forge/README.zh.md)——提供方与共享轮询。
- [Session 投影](../../session/session-projection/README.zh.md)——投影注册与检查点。
- [绑定决策](../../../.agents/notes/implemented/feature/2026-10-09-session-change-request-bindings.zh.md)——为何绑定从 shell 结果派生、状态只留在宿主侧。

-----

<a id="model-experience"></a>
## 模型体验

无：绑定、发现记录与轮询到的状态都不会进入模型请求；客户端通过 Session 摘要看到绑定。

#### KV Cache 影响

无。绑定记录是位于模型可见对话之外的可忽略插件记录。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **有限的 shell 识别**——数字编号需要字面量仓库参数。不识别变量展开、替换、多行脚本、未知选项、别名和其他 CLI。复合命令或 PowerShell 中未写明主机的仓库需要输出 URL 或使用 `track`，实时解析器无法恢复它们原本的环境。重放会恢复已确认的引用记录和主机明确的编号参数，不会执行 `gh`；没有记录 URL 的旧调用若未写明主机，需要再次调用或使用 `track`。分支选择器和 `git push --porcelain` 仍不受支持。
- **发现时机**——在别处为某个分支打开的变更请求，要等到该分支的下一次推送、forge 面板等调用方再次报告该分支，或 `track` 之后才会出现。
- **没有模型工具**——模型目前还不能读取或修改绑定。
- **后台输出**——`run_in_background: true` 只返回作业 id，不含绑定证据。转入后台的前台命令只贡献首个结果中的输出；后续作业输出不会补充绑定。首个结果中未出现的变更请求需用 `track` 绑定。
- **未带完整引用的标签更新**——强制更新或已是最新的标签，如果输出未带 `refs/tags/`，会被当成分支。发现过程可能绑定同名分支的打开状态变更请求；可用 `dismiss` 隐藏错误绑定。
- **按 Session 绑定**——subagent 的 Session 保有自己的绑定；父 Session 不会汇总它们。
- **查找失败不可见**——查找失败只写入宿主日志；Session 与其监听方都看不到。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
