---
description: "面向用户与维护者的文件型凭据提供方：选择、配置或排查本地凭据存储及其环境分层。"
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-local

[English](README.md) | 中文

## 概述

`dsh-credentials-local` 是产品默认的本机凭据存储：harness home 下的一个私有文件，存放 API 密钥与其他机密，可由配置界面写入，你自己编辑该文件时也会自动重载。该文件是带版本的文档，含一个存放密钥值的 `refs` 分节和一个存放持久化按插件记录的 `records` 分节，因此授权 grant 或提供方环境值能与密钥一起跨重启保留。密钥来自四个位置，顺序固定：你启动时的环境优先，其次是存储文件，再次是项目和主目录的 `.env` 文件。你保存的密钥会立即生效，即使某个 `.env` 里还留着更旧的密钥。只有你的 OS 用户能读取该文件，而且产品绝不把文件路径交给 agent（智能体）。

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

本包为组合提供本地凭据存储：API 密钥与其他机密只需保存一次，之后每个按名引用它们的请求都会用到。常用路径是显式的：加载存储、通过配置界面或 `ctx.credentials` 保存密钥，然后在需要时由产品解析。

### 何时使用

把它作为默认本地存储：产品的 base 组合会加载它，你通过配置界面保存的密钥会立即生效。当部署必须让提供方密钥远离自身 agent 时选择其他存储——文件权限做不到这一点，因为 agent 的工具进程以你的 OS 用户身份运行（见「谁能读取该文件」）。

### 设置

```yaml
- name: '@deepseek-ai/dsh-credentials-local'
  config:
    path: /absolute/path/to/.credentials.yaml
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `<harness home>/.credentials.yaml` | 凭据文件所在位置 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | `path` 缺省时使用的 harness home |
| `watch` | `true` | 文件在磁盘上变化时自动重载 |
| `debounceMs` | `100` | 变化后等待这么久再重载，单位为毫秒 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-credentials-local)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 存储与移除密钥

用 `set` 保存密钥、用 `unset` 移除、用 `describe` 检查密钥是否已配置——与凭据 API 提供的操作相同：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('DEEPSEEK_API_KEY')
await ctx.credentials.set(ref, 'sk-…')          // save
await ctx.credentials.describe(ref)             // { configured, source?, writable } — never the value
await ctx.credentials.unset(ref)                // remove
```

你保存的密钥会被下一个按名引用它的请求使用；`describe` 报告它是否已设置、来自哪里、能否写入——绝不返回值本身。记录也持久化在同一文件中：插件按 `<owner>/<id>` 寻址一条记录，并用 seam 的记录操作（`readRecord`、`describeRecord`、`listRecords`、`modifyRecord`、`deleteRecord`）管理它。

### 密钥从哪里来

密钥按一个固定顺序解析——先有值的位置胜出：

| 位置 | 可写？ | 优先于 |
|---|---|---|
| 你启动时的环境（`DEEPSEEK_API_KEY=… dsh`） | 否 | 一切 |
| 存储文件 | 是（`set`/`unset`） | 两个 `.env` 文件 |
| 项目的 `.env`（`<invocation cwd>/.env`） | 不在此处 | 主目录 `.env` |
| 主目录的 `.env`（`$DSH_HOME/.env`） | 不在此处 | 无 |

启动环境优先，因为按次覆盖——`DEEPSEEK_API_KEY=… dsh`、CI 机密、容器 `-e`——代表本次运行的明确意图；它无法从产品内部修改，因此被报告为只读，写入会被拒绝。其他一切来源都输给存储文件，这正是你保存的密钥会立即生效的原因，即使某个 `.env` 里还留着更旧的密钥；没有存储任何东西时，那两个 `.env` 层会参与解析。环境层是启动时拍摄的启动器[环境快照](../../util/launch-environment/README.zh.md)，因此启动之后才导出的变量不会被看到。

### 凭据文件本身

带版本的 YAML 文档，每个键空间一个分节，除此之外别无他物：

```yaml
version: 1

refs:
  DEEPSEEK_API_KEY: sk-…
  OPENAI_API_KEY: sk-…

records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:                    # written verbatim; this provider does not interpret it
      type: oauth
      access: eyJhbGciOi…
      refresh: rft_9f8e7d…
      expires: 1786000000000
  llm-pi-ai/amazon-bedrock:
    kind: api-key               # environment values, no key: this route uses an AWS profile
    env:
      AWS_PROFILE: prod
  llm-pi-ai/amazon-bedrock-dev:
    kind: api-key               # neither: the owner confirmed the ambient credential chain
```

你可以直接编辑该文件——存储会自动重载并接收变更，包括你删除的密钥或记录。`refs` 按环境变量名存放密钥值；`records` 按 `<owner>/<id>` 存放按插件凭据，每条都带 `api-key` 或 `grant` 标签，其中 grant 的 payload 由存储逐字保留，因为只有它的拥有者能解释。产品写入时会保留注释与未触及条目的排版；直接位于某条目上方的注释属于该条目的注解，会随它一起删除。文件只存放凭据，因此任何其他内容都会被明确拒绝，而不是被静默忽略：非 mapping 的根、未知的顶层键、在其键空间内不可寻址的键、类型错误或空的值、未知的记录标签或字段、重复键以及格式错误的 YAML 都会在启动时失败；运行期热重载时则保留最后可用内容并告警。

密钥的值可以是任意文本，包括多行值——不需要任何引号技巧。空值等于「没有密钥」，这正是文件中的空字符串被拒绝的原因：移除密钥是删除它，而不是把它置空。`grant` 的 payload 必须经受 JSON 往返，进出两个方向都会强制这一点，因此存储会拒绝无法逐字读回的值。如果磁盘上的文件已无法解析，保存会失败，而不是覆盖产品读不懂的内容。

### 谁能读取该文件

只有你的 OS 用户能读取该文件：产品以仅属主可访问的权限创建它，在 POSIX 上还会拒绝加载任何其他用户可读的文件——错误会提示你运行 `chmod 600`。Windows 没有可检查的 mode，因此在那里跳过该检查而不是伪造它。agent 不是另一个用户：它的工具进程以你的身份运行，因此它们读这个文件与读你拥有的任何其他文件毫无二致。产品绝不把文件路径交给 agent，也绝不把文件载入环境，因此要拿到某个值，需要刻意去读一条并未交给 agent 的路径。这是审慎，不是边界：必须让提供方密钥远离自身 agent 的部署无法靠文件权限做到。

### 可能出错的地方

- **启动环境提供的密钥是只读的**——`DEEPSEEK_API_KEY=… dsh` 在本轮运行中优先，保存或移除它都会被拒绝。请先在启动 shell 中清除该变量。
- **空值无法保存**——存储空字符串会被拒绝；请改为移除密钥。
- **存储拒绝加载它无法信任的文件**——任何其他用户可读的文件、格式错误的 YAML 或无法到达的路径都会在启动时失败；运行期热重载则保留最后可用内容并告警。
- **同一时刻的修改都会被保留**——如果你在产品写入的同时编辑文件，你的变更会被并入，而不是被覆盖。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **一套明确的优先级。** 继承环境优先，因为它是本次运行的明确意图且无法从进程内部修改；它之下的所有来源都输给受管存储，因此已存密钥永远不会被陈旧的 `.env` 挤掉。
- **文档只存放凭据。** 它是带 `refs` 与 `records` 分节的版本化文档，而不是 dotenv 文件：一个 harness 拥有、且绝不物化进环境的存储，不能同时充当用户的环境层，否则会以自己的优先级遮蔽非机密条目。
- **写入打补丁，重载整体替换。** 行编辑在跨进程写锁下保留注释与未触及条目；重载整体交换解析后的快照，已删除条目绝不在内存滞留。
- **信任攸关处明确报错。** 启动与重载都会拒绝不可读、无效或可被属主之外读取的文档；失败的活动重载保留最后可用快照并告警，而不是拖垮进程。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方：层解析、严格文档解析、写锁下的引用与记录写路径、watcher 生命周期、权限检查 |
| — | 不发布运行时不变式伴生入口；事件生命周期约定归 seam 伴生插件。 |

### 解析与写入路径

`resolve` 与 `describe` 按优先级顺序读取继承环境快照、已解析文档快照与 `.env` 后备层。`set`/`unset` 排入同一条独占操作链：入口检查提前拒绝（已释放、空值、被环境遮蔽），队列在运行时会重新判定，随后在写锁下执行读-改-写、提交，并恰好触发一次 `credentials/reference-updated`。

`modifyRecord` 走同一条链与同一把锁：它重新读取文档、把当前记录交给变更函数、准入其结果——非空的 api key、能经受 JSON 往返的 grant payload——整体渲染该记录并提交，恰好触发一次 `credentials/record-updated`。并非由产品 CLI 启动的组合只有继承环境这一层。

### 重载生命周期

watcher 事件或 ready 对账把一次刷新排到同一链条之后。`reconcileFromDisk` 重新检查权限、重读文本，文本有差异时整体替换两个快照，并按变更引用或记录逐个发布事件；与文本缓存一致的内容——包括提供方自己的写入——是 no-op。释放时设置 closed 标志、停止接收事件、关闭 watcher，并等待排队操作结算完毕，确保 teardown 之后不再有任何发布。

### 文档版本化

文档携带 `version: 1`，每次写入都会盖上版本戳。启动时若识别出预发布扁平布局——没有 `version` 的裸引用名 mapping——会在写锁下就地升级，把原始行嵌套到 `refs:` 之下，值、注释与拼写逐字节保留；任何其他无版本形态都会按名拒绝，而不会被当作空存储。运行期热重载绝不迁移：中途恢复的扁平文档会保留最后可用快照，直到下一次启动。

### 诊断信息绝不引用值

YAML 解析器自己的消息会引用出错的那行源码，而在这份文档里那行就是机密本身。因此每条诊断只携带错误码与位置——键名可以安全打印，值不行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当提供方级约定不够用时阅读以下页面。它们从 seam 约定逐步进入环境快照、原子写入原语与启动期环境层。

- [凭据引用 seam](../credentials/README.zh.md)——`resolve`、`describe`、`set`、`unset`、记录操作与 seam 的更新事件。
- [凭据子系统参考](../../../docs/subsystems/credentials.zh.md)——`CredentialRef`、按操作解析、对 UI 安全的 `CredentialInfo`、提供方层。
- [启动环境快照](../../util/launch-environment/README.zh.md)——解析读取的冻结层快照，而非 `process.env`。
- [原子写入](../../util/atomic-write/README.zh.md)——每次写入所用的写锁与原子替换。
- [应用启动与 Harness home 各层](../../boot/app-boot/README.zh.md)——产品 CLI 如何把 `.env` 载入快照与 `process.env`。

-----

<a id="model-experience"></a>
## 模型体验

经由 `ctx.credentials` 的消费方间接生效：消费方拥有存储值所启用的全部模型可见行为。

#### KV Cache 影响

无直接失效；存储值绝不进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **同一引用的并发写入是后写胜出**——写锁加读-改-写让并发写入者不会丢掉彼此的条目，但两个写入者编辑同一个引用时仍以较后的写入为准；没有修订检查。
- **同 UID 进程可以读取该文档**——文件效果沙箱模式不会拒绝读取，OS 钥匙串提供方仍是延后项。
- **环境变化不可见**——快照在启动时冻结，因此启动之后 export 的变量既不会进入解析，也不会进入 `describe`；要更换来自环境的凭据需要重启。
- **原子但不具备崩溃持久性**——继承自 `dsh-atomic-write`；存储在启动时重新读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

OS 钥匙串提供方——一种模型进程根本无法读取的存储——是同 UID 限制的延后答案，应当作为平级包与本提供方并列。seam 的接口还为辅助命令与 KMS 后端提供方预留了空间；目前没有任何一种随附。

</details>
