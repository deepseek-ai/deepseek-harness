---
description: "发现具体的 OpenSSH 别名，并贡献按需连接的 SSH 执行环境。"
kind: "package-reference"
---

# @deepseek-ai/dsh-environment-ssh-config

[English](README.md) | 中文

## 概述

将本地 OpenSSH 配置中的具体别名作为可用的执行环境。此提供方通过单目标 SSH 提供方贡献每个选中的别名，并复用其信任与执行行为。发现过程只读取配置文件，不执行 `Match exec`，也不连接目标；这些文件变化时，发现过程会再次运行。调用方选择某个 handle 执行时，才会建立 SSH 连接。本包为实验性软件包，需要显式加入组合。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载注册表和发现提供方。每个选中的目标都需要 SSH 服务端、POSIX shell 和 Node `^24.22.3 || >=26.13.1`。单 SSH 提供方默认在各远程用户的 `~/.cache/dsh/environment/daemon.js` 安装缺失或较旧的守护进程。可通过 `ssh.daemonPath` 将其覆盖为共用绝对路径；校验和替换规则由单 SSH 提供方负责。

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-ssh-config'
  config:
    file: ~/.ssh/config
    handlePrefix: ssh-
    hosts: [build, test]
    debounceMs: 100
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `file` | `~/.ssh/config` | 同时通过 `-F` 传给 OpenSSH 的配置文件 |
| `handlePrefix` | `ssh-` | 每个选中别名前的稳定前缀 |
| `hosts` | `[]` | 具体别名的允许列表；空列表选择所有发现的别名 |
| `debounceMs` | `100` | 被监视的文件和目录连续这么多毫秒没有新的变化后，发现过程再次运行 |
| `ssh` | `{}` | 单 SSH 提供方的共用设置；可选的 `daemonPath` 覆盖各远程用户的缓存路径 |

别名 `build` 使用默认前缀时贡献 `{ handle: 'ssh-build', displayName: 'build' }`。发现过程会跳过任何提供方已经注册的 handle。请先注册显式 SSH 环境，再加载发现提供方；之后使用相同 handle 的注册仍会失败。`ssh` 内的 `host`、`handle`、`displayName` 和 `configFile` 会被拒绝，因为发现提供方负责确定这些值。其他设置沿用[单 SSH 提供方](../environment-ssh/README.zh.md#use-this-package)的默认值和校验规则。完整的字段参考以[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-environment-ssh-config)为准。

别名必须是具体的 `Host` 名称；通配模式和否定名称不会生成环境。发现过程会跟随顶层 `Include` 指令，以及条件恰为 `Host *` 的块中的 Include。其他带 Host 或 Match 条件的 Include 均被排除，以免发现这样的别名：选中它时，其所属条件并不适用。相对 Include 路径从用户的 `.ssh` 目录解析，与 OpenSSH 一致。Include 匹配项按排序后的顺序读取，重复别名会合并，Include 循环会导致失败。`~/.ssh/config` 不存在时不贡献任何别名，因为此时 OpenSSH 不读取任何用户配置；其他源文件缺失、请求的别名未声明或 SSH 设置无效时，加载会失败。

### 配置变化

加载期间，提供方会监视配置文件以及通过其受支持的 Include 读取的每个文件所在的目录，既按到达这些文件的路径监视，也按它们的真实路径监视。提供方还会监视缺失文件或新的 Include 匹配项可能出现的目录，例如 `~/.ssh/config` 不存在时离它最近的现有目录。经过 `debounceMs` 且期间没有新的变化后，发现过程会再次运行。每个新选中的别名获得一个 SSH 子提供方，每个被移除别名的子提供方会被 dispose（资源释放）并关闭其连接，未变化的别名保留其子提供方和已打开的连接。对仍保留的别名的 Host 块所做的编辑，在该别名的下一次连接时生效。

允许列表中的别名不再声明时，会被移除并记录一条警告，再次声明后会重新加入；加载时，允许列表中未声明的别名会导致加载失败。移除可防止 OpenSSH 把未声明的名称当作主机名解析。如果某次变化使配置无法读取，例如出现解析错误、Include 循环，或删除了 `~/.ssh/config` 以外的文件，提供方会保留之前的别名并记录警告；提供方仍保持加载状态，并应用下一份可读的配置。SSH 提供方拒绝的新别名（例如以 `-` 开头的别名）会被记录日志并跳过。每次重新发现时，发现过程都会跳过其他提供方注册的 handle。如果其他提供方注销了这样的 handle，发现过程会在下一次配置变化或提供方重新加载时接管它。

移除发现提供方会停止监视、移除其 SSH 子提供方并关闭相应连接；其他提供方注册的环境会保留。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`ssh-config` 解析本地文件。发现遍历过程读取具体别名和支持的 Include，不计算 Match 表达式，并收集需要监视的目录，包括失败之前已到达的目录。对于每个 handle 未被注册表列出的选中别名，提供方使用已解析的共用配置创建单 SSH 子插件，并等待其加载。每个子传输在打开连接时启动全新的 stdio 守护进程；注册表复用活跃连接。子 fiber、其注册项和 watcher 归发现提供方的生命周期管理。执行使用注册表的共用协议。

非递归的 `fs.watch` watcher 以目录路径和文件标识为键，因此链接目标已更改的符号链接或重新创建后具有新标识的目录会被重新监视。如果 watcher 报告的事件指明其所监视的目录本身或未指明任何目录项（被监视的目录被删除、对它的监视随之结束时，Linux 会报告这样的事件），或者 watcher 失败，那么即使标识未变，该 watcher 也会在下一次重新发现时被替换。任何事件都会重新开始 `debounceMs` 计时，各次重新发现依次运行；意外失败的重新发现会被记录日志，下一个事件会启动新的一次重新发现。监视开始时，以及某次重新发现改变了被监视的目录时，也会开始计时，因此新 watcher 尚未报告的变化仍会被读取。dispose 时会先等待正在运行的重新发现结束，再关闭 watcher；该次重新发现失败时也是如此。

| 文件 | 职责 |
|---|---|
| [`src/discover.ts`](src/discover.ts) | 文件发现、具体别名、Include 遍历和需要监视的目录 |
| [`src/watch.ts`](src/watch.ts) | 随目录集合变化而调整的目录 watcher |
| [`src/index.ts`](src/index.ts) | 提供方配置、SSH 子插件组合与重新发现 |

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

- [环境注册表](../environment/README.zh.md)——元数据与显式 handle 选择。
- [单 SSH 提供方](../environment-ssh/README.zh.md)——信任决策与连接行为。
- [环境子系统](../../../docs/subsystems/environment.zh.md)——公共服务参考。

-----

<a id="model-experience"></a>
## 模型体验

通过选择其所贡献环境的工具间接影响模型；这些工具负责 schema、渲染结果和日志。此提供方不添加提示词段、模型工具或 Session 事件。

#### KV 缓存影响

无；本包既不组装也不发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 监视依赖 Node `fs.watch`。不报告变化的文件系统（例如某些网络挂载）需要在配置变化后重新加载提供方。在 macOS 上，新的 watcher 只有在启动完成后才报告变化；在此之前发生的变化会由 `debounceMs` 之后的那次重新发现读取，除非启动耗时更长。无法监视的目录（例如达到系统 watcher 数量上限之后）会被记录日志；发现过程会在下一次重新发现时再次尝试监视它，而只有其他被监视目录中的变化或提供方重新加载才会启动下一次重新发现。
- 监视会沿符号链接一直跟随到最终目标所在的目录。修改多级链接中某个中间链接的指向，要等到被监视目录中下一次发生变化时才会生效。
- 除恰为 `Host *` 的情况外，不枚举其他有条件的 Include。显式配置的单 SSH 提供方仍可连接这些别名。
- 所有选中的别名共用配置的 SSH 设置，包括显式设置的 `daemonPath`。未覆盖路径时，各目标自行解析其远程用户的缓存路径。需要不同设置的目标应使用显式配置的提供方。
- 此提供方不安装远程 Node，也不从 `known_hosts` 发现目标。守护进程准备、兼容性检查和失败处理沿用单 SSH 提供方的行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

解析器测试使用相互隔离的 SSH 目录和配置文件。Loader 测试验证惰性贡献与移除行为，且不连接用户目标。监视测试使用临时主目录和文件，并等待注册表变化事件或记录的警告；防抖和 dispose 测试使用模拟定时器。一个测试通过单 SSH 提供方模拟 OpenSSH 的 fixture（测试前置数据）保持一条真实连接。

</details>
