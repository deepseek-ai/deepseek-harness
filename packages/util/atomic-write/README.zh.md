---
description: "原子文件替换与跨进程写锁，供绝不允许在磁盘上留下不完整、被符号链接劫持或权限过宽内容的包使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-atomic-write

[English](README.md) | 中文

## 概述

`dsh-atomic-write` 一步原子地替换文件内容：目标的读取方总是看到完整的旧内容或完整的新内容，绝不看到部分写入。它还通过写锁跨进程串行化读-渲染-提交循环，因此同一文件的并发写入方无法复活彼此替换掉的状态。调用方为每次替换声明权限位，全新 inode 会带着这些权限位走完交换，因此替换权限过宽的旧文件时会直接收窄，不存在 chmod 竞态。它是一个零依赖库，由用户设置文档与凭据存储这类文件型存储共享；`cordis.yml` 无法加载它，而且由于没有 `fsync`，崩溃持久性由调用方负责。

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

当文件型存储必须替换一份已渲染好的字符串、且绝不允许暴露部分写入、符号链接劫持或权限过宽状态时，使用 `writeFileAtomic`；当多个进程读写同一文件时，使用 `withFileLock`。最小路径是一次调用，传入最终内容与替换 inode 的权限位。

### 原子写入文件

```ts
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const text: string
await writeFileAtomic('/home/u/.dsh/settings.yaml', text, { mode: 0o600 })
```

父目录会按需创建，读取方只会观察到旧内容或完整的新内容。在 Windows 上，报告为 `EACCES`、`EBUSY` 或 `EPERM` 的瞬时替换干扰会在有界时间内重试；任何剩余失败都会移除临时文件，并保持目标文件不变。

### 协调写入方

对于单靠原子提交无法保证安全的读-渲染-提交循环，请在操作期间持有写锁：

```text
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

declare const render: (previous: string) => string
declare const readCurrent: () => Promise<string>

await withFileLock('/home/u/.dsh/settings.yaml', async () => {
  const previous = await readCurrent()
  await writeFileAtomic('/home/u/.dsh/settings.yaml', render(previous), { mode: 0o600 })
})
```

只有写入方会竞争——读取方从不取锁——竞争者按指数退避，超时即以错误失败，而不是无限阻塞。竞争者等待多久由每次调用经 `waitMs` 声明：默认值只按纯文件工作量级选定，因此持锁方循环若包含一次网络往返——例如刷新过期 token 的凭据变更——就应声明更长的值，否则该文件的其他写入方在这段时间内都会失败。退避节奏保持固定。竞争者绝不移除已有锁，因为文件存续时间无法证明其持有者已经停止。

### 需要规划的失败

锁的父目录必须已经存在，因此 `withFileLock` 会在运行操作之前拒绝无效的父目录层级。持锁进程退出时会把锁文件留在原地；后续写入方超时失败，操作者只有在确认没有写入方仍持有该锁后才会移除它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包建立在一个分离之上：原子提交负责交换，写锁负责跨进程排序。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `writeFileAtomic` 与 `withFileLock`，即本包的全部接口 |
| — | 不发布运行时不变式伴生入口；替换约定由单元测试覆盖。 |

### 写入路径

`writeFileAtomic` 先以独占创建（`wx`）打开一个随机后缀的同级文件并写入内容，然后 rename 到目标上。独占打开拒绝跟随预先埋在可猜测临时路径上的符号链接；同目录兄弟文件保证 rename 落在同一文件系统上；rename 替换的是符号链接目标本身，绝不写穿到其指向的文件。Windows 重试会保留同一份完整的兄弟文件，并采用有界指数退避，因此协作式写锁之外的软件瞬时占用目标时，不会让安全替换立即失败；[重试决策](../../../.agents/notes/implemented/bug-fix/2026-08-29-windows-atomic-replace-retry.zh.md)记录了理由与被拒绝的替代方案。

`withFileLock` 以 `wx` 创建 `<filename>.lock` 同级文件。`EEXIST` 直接表示竞争；只有一次新的 `lstat` 确认锁路径存在时，`EPERM` 才表示竞争，从而兼容 Windows 的独占创建行为，又不掩盖无关的权限故障。锁记录创建者的 PID，由持有者在 `finally` 中移除；竞争按指数退避，在每次调用声明的 `waitMs` 期限（默认两秒）过后失败。

### 交换为何安全

- **全新 inode，调用方声明的权限位**——临时文件带着 `mode` 走完 rename，因此收窄权限过宽的文件没有 chmod 竞态。`mode` 为必填，让权限决策始终可见于每个调用点。
- **读取方从不竞争**——rename 提交是原子的，读取方无需加锁。
- **竞争者绝不移除锁**——文件存续时间无法区分已崩溃的所有者与暂停但仍存活的写入方；恢复是操作者的动作。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要了解消费它的存储或本原语所属的家族时，阅读以下页面。

- [用户设置文件存储](../../settings/settings-file/README.zh.md)——每次写入都通过本包替换的设置文档。
- [凭据存储](../../credentials/credentials-local/README.zh.md)——本包加锁并替换的凭据文件。
- [util 组映射](../README.zh.md)——本包所属的零依赖工具家族。

-----

<a id="model-experience"></a>
## 模型体验

无：本包是纯文件系统写入原语，不注册任何面向模型的内容。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不是合适的工具。它们是当前包约束，不是任务积压。

- **原子但不保证持久**——不对文件或其所在目录做 `fsync`，因此崩溃后可能观察到 rename 被回退。此处的文件型存储在启动时重新读取并重新发布，把持久性留作调用方的策略。
- **仅支持字符串内容**——在有消费方需要之前，不提供 `Buffer` 或流式形态。
- **遗留锁需要操作者恢复**——持锁进程退出时可能留下同级锁文件；后续写入方超时也不会删除它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

一种对文件及其父目录执行 `fsync`、并在 Windows 上保留仅属主权限的持久性替换方案仍未实现（在源码中记录为 `settings-atomic-durability`）。

</details>
