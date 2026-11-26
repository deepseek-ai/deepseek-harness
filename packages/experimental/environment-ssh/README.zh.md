---
description: "通过严格检查主机密钥的 OpenSSH 连接贡献一个执行环境。"
kind: "package-reference"
---

# @deepseek-ai/dsh-environment-ssh

[English](README.md) | 中文

## 概述

在可通过 OpenSSH 访问的机器上运行环境函数。本提供方向环境注册表贡献一个稳定的句柄和展示名称，并使用你的 SSH 配置确定用户、密钥、代理和跳板主机。执行守护进程缺失或版本较旧时，提供方会安装匹配版本；每个新连接启动全新进程，活跃连接则复用该进程。未知主机密钥需要固定指纹或人工确认；密钥变化时连接失败。本包属于实验性能力，需要显式组合。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在本地安装 `ssh` 和 `ssh-keygen`。目标机器需要 SSH 服务端、POSIX shell 和 Node `^24.22.3 || >=26.13.1`。与注册表一起挂载本提供方。首次执行时建立连接并准备守护进程。默认情况下，远程 Node 通过 `os.homedir()` 确定 SSH 用户的主目录，并将守护进程保存到 `~/.cache/dsh/environment/daemon.js`。可将 `daemonPath` 设为远程绝对路径以覆盖此位置。

```yaml
- name: '@deepseek-ai/dsh-environment'
- name: '@deepseek-ai/dsh-environment-ssh'
  config:
    handle: ssh-build
    displayName: Build machine
    host: build-box
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `handle` | `ssh-` 后接 `host` | 注册表中不透明且稳定的标识符 |
| `displayName` | `host` | 面向用户的展示名称，允许重复 |
| `host` | 必填 | OpenSSH 目标或别名 |
| `daemonPath` | 远程 `~/.cache/dsh/environment/daemon.js` | 可选的绝对目标路径；守护进程缺失或版本较旧时自动安装 |
| `node` | `node` | 目标机器上的 Node 可执行文件 |
| `configFile` | OpenSSH 搜索规则 | 通过 `-F` 传给每次 SSH 操作的配置文件 |
| `hostKeys` | `[]` | 对未知主机接受的已核实 `SHA256:` 指纹 |
| `knownHostsFile` | `$DSH_HOME/state/environment-ssh/known_hosts` | 写入显式信任密钥的文件 |
| `ssh`, `sshKeygen` | `ssh`, `ssh-keygen` | 不含选项的可执行文件 argv 前缀 |
| `killGraceMs` | 2000 | 强制终止 SSH 进程前的宽限时间 |
| `maxOutputBytes` | 64 KiB | 保留的 helper 输出和 SSH stderr |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-environment-ssh)提供完整字段参考。不同注册项可能冲突时，应设置不同的 handle。展示名称不用于选择环境。

### 主机密钥

每次打开连接时，都通过 `ssh -G` 读取目标的有效设置。配置的 known-hosts 文件中已有的密钥通过 `StrictHostKeyChecking=yes` 检查。变化的密钥不会被自动重新信任。

对于未知主机，OpenSSH 通过用户配置的代理或跳板主机获取对端提供的密钥，在 `accept-new` 下将其记录到临时文件，并在认证前停止。只有当指纹固定在 `hostKeys` 中，或运行的 `confirm` 回调在用户于目标机器上核对指纹后取得同意时，提供方才接受该密钥。确认问题包含供客户端渲染的主机名、端口以及每个密钥的类型和指纹，还包含 `detail`，即相同信息的英文文本。接受的密钥追加到 `knownHostsFile`，用户自己的 known-hosts 文件保持不变。否则，`SshHostKeyUntrustedError` 会报告 `ENVIRONMENT_SSH_HOST_KEY_UNTRUSTED` 和待核对的指纹。

### 守护进程准备

建立主机信任后，提供方检查配置的 `node` 可执行文件是否存在、是否满足受支持的版本范围，以及是否提供所需的 Node 内置模块。提供方通过已安装的 `@deepseek-ai/dsh-environment/daemon.js` 导出解析独立打包文件。只有当已有守护进程是普通文件、首行元数据中的环境包版本和协议版本完全匹配，且整个文件的 SHA-256 摘要与本地打包文件一致时，提供方才复用该文件而不重写。

如果守护进程不存在，或其可识别的语义版本低于本地打包文件的版本，提供方会通过 SSH stdin 将打包文件发送给远程 Node。Node 在私有的随机临时文件中校验上传内容的摘要，并在发布前取得目录锁。随后重新检查目标，通过排他硬链接创建尚不存在的文件，或原子替换先前检查过的旧版本文件。目标若已变化，必须与请求的打包文件完全匹配，否则安装失败。锁被占用时会报告错误，需在另一安装进程结束后重试。准备过程不需要 `scp`、SFTP、`cat` 或 `mv`。

如果远程安装进程被强制终止，可能遗留私有的随机 `<daemonPath>.upload-*` 文件或 `<daemonPath>.install-lock` 目录。安装进程绝不会在最终路径发布尚未写完的守护进程。检查遗留文件和目录，并且只在没有安装进程使用它们时手动移除。

版本较新、无法识别，或版本相同但协议或摘要不同的守护进程会触发 `ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE`，文件保持不变。检查文件后，手动移除或替换它，或配置一个尚不存在的目标路径。自动替换仅适用于可识别且较低的语义版本；提供方绝不会降级较新的守护进程。`SshEnvironmentError` 还会报告 `ENVIRONMENT_SSH_NODE_NOT_FOUND`、`ENVIRONMENT_SSH_NODE_UNSUPPORTED`、`ENVIRONMENT_SSH_DEPENDENCY_MISSING` 或 `ENVIRONMENT_SSH_BOOTSTRAP_FAILED`，并说明缺少的前置条件或修正方法。

### 独立环境

每个新通道启动各自的远程守护进程，即使目标机器相同也是如此。注册表为同一注册项复用活跃通道。句柄标识注册项，不选择远程常驻实例。移除提供方会撤销其注册表贡献并关闭通道。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

提供方贡献元数据和传输实现，不实现函数执行协议。完成信任检查并准备好守护进程后，SSH 在目标机器上以模块模式启动打包后的守护进程，并传入 `serve --stdio`。注册表认证该通道后，才通过通用请求通信端运行函数。传输实现管理 SSH 进程，并在注册表释放通道时关闭该进程。标准输入和输出传送帧；退出状态和保留的 stderr 说明连接终止的原因。SSH 配置发现为每个选中的别名组合这个相同的插件。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、注册表贡献、信任决策和 SSH 连接 |
| [`src/bootstrap.ts`](src/bootstrap.ts) | 远程前置条件、守护进程兼容性与原子安装 |
| [`src/openssh.ts`](src/openssh.ts) | 有效设置、密钥查找、指纹和 POSIX 命令引用 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [环境注册表](../environment/README.zh.md)——执行与生命周期语义。
- [SSH 配置提供方](../environment-ssh-config/README.zh.md)——通过本提供方使用多个别名。
- [本地提供方](../environment-local/README.zh.md)——受管理的本地执行。
- [SSH 提供方系列](../../ssh/README.zh.md)——Session 范围的文件系统与子进程服务。

-----

<a id="model-experience"></a>
## 模型体验

通过工具发起的环境运行间接影响模型；schema 和渲染结果由这些工具负责。本提供方不增加提示词段、模型工具或 Session 事件。

#### KV 缓存影响

无；本包既不组装也不发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 提供方不安装远程 Node。SSH 用户需要创建守护进程目录以及安装或替换文件的权限。版本较新、无法识别或版本相同但不兼容的文件需要人工检查，绝不会被自动替换。
- 每次打开连接都会启动一个 SSH 进程和全新的远程守护进程。底层连接共享由 OpenSSH 的 `ControlMaster` 设置决定。关闭 SSH 后，只有当远程守护进程观察到其输入已关闭时，远程函数才会结束；本提供方不提供远程进程监管器。
- 远程登录向 stdout 输出内容会破坏协议信道。
- 信任记录通过 `knownHostsFile` 管理，尚无专用的信任设置页面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

组合测试使用 `tests/fixtures/fake-openssh.ts` 替代 OpenSSH 工具，同时运行真实的 stdio 执行守护进程。测试验证信任决策、配置和连接复用，不连接用户主机。

</details>
