---
description: "为在链接 Git 工作树中工作的 Session 授予该工作树与仓库共享的 Git 目录的写权限，面向在 workspace-write 下组合工作树 Session 的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-policy-git

[English](README.md) | 中文

## 概述

让在链接 Git 工作树中工作的 Session 能在 `workspace-write` 下运行写入仓库数据的 Git 命令，例如 `git add` 和 `git commit`。本插件把工作树与仓库共享的 Git 目录注册为该 Session 的额外可写目录，并在 Session 到别处工作时移除注册。[工作树服务](../worktree/README.zh.md)会挂载它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载了工作树服务的组合已经带有本插件。其他组合把它与 `fs`、`sandboxPolicy`、`workingDirectory` 的提供方一起挂载；它没有配置。

```yaml
- name: '@deepseek-ai/dsh-sandbox-policy-git'
```

### Session 可以写什么

链接工作树把自己的索引、`HEAD` 以及仓库的对象和引用存放在仓库的 Git 目录中，通常是 `<repository>/.git`，它位于工作树之外。[沙箱策略](../../sandbox/sandbox-policy/README.zh.md)以 Session 工作的目录为界，因此没有授权时这些写入会被拒绝。当 Session 的目录是某个链接工作树的顶层目录时，本插件通过 `ctx.sandboxPolicy.registerWritableRoot` 注册该 Git 目录。注册遵循该方法的规则：只在 `workspace-write` 下生效，只对该 Session 生效，只对之后解析策略的操作生效，并且不随 Session 保存。

授权覆盖整个 Git 目录，包括 `hooks`、`config` 以及仓库其他工作树的管理目录。用户之后在沙箱外运行的 Git 命令会执行其中的钩子和配置的程序；在主检出目录中工作的 Session 也是如此，它的根目录包含同一个目录。

### 何时读取布局

本插件在三个时刻读取 Session 目录的布局，调用方都会等待读取完成：

- Agent 创建时（包括恢复、清空和压缩），在 Agent 接受输入之前；
- Host 每次移动 Session 的目录之后，在 `ctx.workingDirectory.set` 返回之前；
- 每次模型请求之前的目录校验时。

每次读取都用结果替换该 Session 的注册，因此已消失或不再指明该工作树的 Git 目录会在下一次读取时停止授权。读取接受调用方的取消；被取消的读取不改变任何状态。

授权属于读取它时所在的目录。Host 把 Session 移到另一个目录时，授权在提交这次移动的同一步结束，早于对新目录的读取，因此不会有策略把新目录与旧目录的 Git 目录组合在一起。销毁 Agent 或卸载插件会移除注册；此时仍在途的读取不再注册任何目录，卸载会等它结束。

### 哪些目录符合条件

Session 目录中的文件可由该 Session 写入，因此仅凭其中的 `.git` 文件不会授权。只有 Git 目录自身把该目录指明为工作树，并且符合 `git worktree add` 写出的布局时，目录才符合条件：

1. `<directory>/.git` 是普通文件，其中的 `gitdir:` 行解析为已存在的 `<common>/worktrees/<name>`。
2. `<common>/worktrees/<name>/commondir` 解析为 `<common>`。
3. `<common>/worktrees/<name>/gitdir` 解析为 `<directory>/.git`。
4. `<common>` 既不包含该目录，也不位于该目录之内。
5. `<common>` 含有 `HEAD` 文件、`objects` 目录和 `refs` 目录。
6. `<common>/worktrees/<name>` 不在部署方或其他插件已允许该 Session 写入的任何目录之内。Session 能写的指针文件无法为它上方的目录作保，因此插件既不会凭一个可写的 `<X>/worktrees/<name>` 授权 `<X>`，也不会把只配置了某个管理目录的授权扩大到整个 Git 目录。插件授权过某个 Git 目录之后，后续读取接受同一个目录。

绝对与相对指针、裸仓库的工作树、嵌套在另一个工作树中的工作树都符合条件。主检出目录不需要授权。工作树的子目录和子模块检出目录不符合条件。

### 失败

无法读取的布局不产生授权，超过 8192 字节的指针文件也不产生授权。本插件按 Session 和目录各记录一次警告，触发读取的目录操作或 Agent 创建仍然成功；下一次读取会重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本插件监听 `agent/created`、`agent/disposed` 和 `working-directory/access` 流水线，并在后者的 `next()` 返回已提交的目录之后读取。一个前置的 `session/event` 监听器在 `workspace-root/change` 指向另一个目录时结束授权，这正是提交移动的那一步；不发布事件的 Session 则在开始读取新目录时失去授权。本插件为每个 Session 保存一次注册以及读取它时所在的目录。如果读取完成之前 Session 已离开被读取的目录，该次读取会被丢弃，因为随后的移动有自己的读取；读取期间 Agent 已被销毁的读取同样被丢弃。所有注册归插件的上下文所有，因此卸载插件会移除全部注册。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 监听器与每个 Session 的注册 |
| [`src/linked-worktree.ts`](src/linked-worktree.ts) | 通过执行环境的文件系统校验布局 |

本包不发布运行时不变量伴随模块：注册归沙箱策略所有，Session 的目录归工作目录服务所有，本包两者都不保存。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [沙箱策略](../../sandbox/sandbox-policy/README.zh.md)——注册规则与模型可见的策略文本。
- [工作目录](../../session/working-directory/README.zh.md)——Host 移动与 `working-directory/access` 流水线。
- [工作树服务](../worktree/README.zh.md)——把 Session 移入和移出工作树的操作。
- [授权决策](../../../.agents/notes/implemented/architecture/2026-11-18-linked-worktree-git-directory-grant.zh.md)——为什么授权整个 Git 目录，以及为什么采用这些校验。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过沙箱策略的 `sandbox:policy` 上下文：Session 的模式为 `workspace-write` 时，它在 `Additional writable directories` 中列出已注册的 Git 目录。

#### KV Cache 影响

本包不贡献提示词文本。注册被添加或移除时沙箱策略的上下文会变化，这与 Host 移动引起的工作目录上下文变化同时发生；稳定的系统提示词不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Windows**——本插件在 Windows 上不注册任何目录，因为那里的进程限制忽略额外可写目录。在那里，工作树 Session 中写入仓库的 Git 命令需要获批的升权或 `danger-full-access`。
- **仅顶层目录**——目录是工作树的子目录或子模块检出目录的 Session 不会获得授权。
- **没有更窄的授权**——注册接口只接受目录，因此无法把 `hooks` 和 `config` 排除在授权之外。
- **两次读取之间**——被删除的 Git 目录在下一次读取之前仍保持注册，在此之前该 Session 的受限操作以 `SANDBOX_INVALID_ROOT` 失败。在移动提交之前已解析策略的操作保留它解析到的权限；在提交之后、新目录读取结束之前解析策略的操作没有授权。
- **更早的权限**——校验把指针文件与 Session 现在能写的目录相比较。在 Session 能写更多目录时预先放好的指针文件和 Git 目录条目（例如 `danger-full-access` 下，或进入工作树之前在主检出目录中）可以通过校验；这样得到的授权只会落在该方当时已经能写的目录上。平台临时目录也不参与比较。
- **常规条目**——`HEAD`、`objects` 或 `refs` 是符号链接的 Git 目录不符合条件。
- **没有 Agent 的 Session**——只有活跃 Agent 的 Session 会获得授权。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
