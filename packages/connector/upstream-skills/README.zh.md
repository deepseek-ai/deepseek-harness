---
description: "把 CLI 应用插件的入口技能注册到 Host Service `ctx.upstreamSkills`：它从厂商 GitHub 仓库固定提交的一个目录下载入口索引的上游文件，校验后发布到 DSH 缓存，再在这些文件之上列出入口技能。"
kind: "package-reference"
---

# @deepseek-ai/dsh-upstream-skills

[English](README.md) | 中文

## 概述

企业微信、腾讯会议等 CLI 应用插件向 `ctx.upstreamSkills` 注册，以获取厂商只在自己 GitHub 仓库里发布的子指南。插件保留自己的入口 `SKILL.md`，并按提交、总大小和摘要固定该仓库的一个目录。插件加载时，Service 下载这个提交的归档，校验保留的文件，把它们发布到 DSH 缓存，并列出入口技能，把发布目录作为它的基础目录。仓库和插件的 npm 包里都没有这些文件的副本。Service 由基础组合包加载，在有插件注册之前不下载任何内容。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

CLI 应用插件的 Host 行注入 `upstreamSkills` 并调用一次 `register`；注册持续到插件卸载，或插件释放返回的句柄。

### 何时选用

上游技能只存在于厂商 GitHub 仓库的 CLI 应用插件，在 Host 行中注册，让每台用户电脑在运行时从厂商处下载这些技能。CLI 内嵌子指南的插件通过 CLI 读取它们，如飞书；发布包里附带带校验和的技能归档的插件，把它和可执行文件一起下载，如钉钉。

### 最小配置

[基础组合包（base bundle）](../../bundle/base/cordis.patch.yml)在基于它的每个 profile 中加载这个 Service，位于它注入的 `skills` 注册表之后：

```yaml
- id: upstream-skills
  name: '@deepseek-ai/dsh-upstream-skills'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillsUrls` | `['https://codeload.github.com']` | 按顺序尝试的 HTTPS 归档下载前缀，不含查询串、片段或凭据；对每个已注册的插件生效 |
| `skillsTimeoutMs` | `120000` | 一个前缀送达完整归档的时限（整数毫秒），超时后尝试下一个；对每个已注册的插件生效 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-upstream-skills)是每个可接受字段的完整来源。`skillsUrls` 为空、某个前缀无法解析为这样的 URL，或 `skillsTimeoutMs` 小于 1 或大于 2147483647，都在加载时失败。

### 注册入口技能

插件的 Host 行在 `inject` 中列出 `upstreamSkills`，固定上游文件，并在 `apply` 中注册：

```ts
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { UpstreamSkillSet } from '@deepseek-ai/dsh-upstream-skills'

const VENDOR_SKILLS: UpstreamSkillSet = {
  repository: 'vendor/vendor-cli',
  commit: '0123456789abcdef0123456789abcdef01234567',
  directory: 'skills',
  exclude: [],
  license: 'LICENSE',
  bytes: 1_754_686,
  sha256: 'c75045cc5297d5886c8a7ff01c993a782e50cbd4aa6f6559394b695157d52e10',
}

export interface Config { skillsDir?: string }

export const inject = ['upstreamSkills']

export function apply(ctx: Context, config: Config): void {
  const skills = ctx.upstreamSkills.register({
    name: 'vendor',
    entry: fileURLToPath(new URL('../skills/vendor/SKILL.md', import.meta.url)),
    set: VENDOR_SKILLS,
    skillsDir: config.skillsDir,
  })
  if (!skills.installed()) ctx.logger.info('vendor: downloading the upstream skills')
}
```

`register` 从入口的 YAML frontmatter 读取名称和描述，以 `name` 注册一个技能提供方，文件不在位时开始下载。注册属于用其 `ctx` 发起调用的插件：该插件卸载时，下载被中止，提供方被移除。以同一个 `name` 再次注册会抛出异常，第一次注册保持不变。

- `name` 是技能提供方的名称、插件的错误和日志记录的前缀，也是 `$DSH_HOME/cache` 下接收下载内容的目录。
- `entry` 是随包发布的入口 `SKILL.md` 的绝对路径，其正文按仓库路径引用上游文件，例如 `skills/<子指南>/SKILL.md`。
- `set` 是 `scripts/upstream-skills-digest.ts` 输出的固定信息。
- `skillsDir` 是插件自己的可选配置字段：一个已按仓库路径存放保留文件的目录。设置后不下载：路径不是目录时 `register` 抛出异常，目录之后被移除时 `install` 以异常结束。

返回的句柄供插件的账号检查使用。`directory` 是 `skillsDir`；没有设置时，在 profile 中是 `$DSH_HOME/cache/<name>/<profile>/skills-<摘要前 16 位>`，没有 profile 时是 `$DSH_HOME/cache/<name>/skills-<摘要前 16 位>`。`installed()` 返回这个目录是否存在。目录存在时 `install(signal)` 立即返回；否则它等待进行中的下载，没有下载在进行时开始一次，下载失败时以异常结束。中止 `signal` 会停止这次下载，其他等待它的调用方也随之结束。通过 `ctx.cliAccounts` 注册的插件把这两个方法作为它的 [`prepare` 步骤](../cli-account/README.zh.md#prepare-before-a-check)传入，即 `ready: () => skills.installed()` 和 `run: signal => skills.install(signal)`：它的账号检查于是等文件就位，模型只在文件就位后得到 CLI 的路径，插件页的重试会重新下载。下载失败会记为警告。`dispose()` 在插件卸载之前撤回注册。以 [`src/index.ts`](src/index.ts) 和 [`src/types.ts`](src/types.ts) 中的约定为准。

### 保留的文件与校验

Service 按顺序从每个 `skillsUrls` 前缀下载 `<前缀>/<owner>/<repository>/tar.gz/<commit>`。某个前缀返回错误状态或空响应体、没有在 `skillsTimeoutMs` 内送达完整归档、发来损坏的归档，或发来的文件与固定信息不符时，记录该前缀并尝试下一个；卸载插件则立即停止。Service 保留 `directory` 下除 `exclude` 列出的路径之外的所有普通文件，以及 `license`，并保持它们的仓库路径。以下归档会被拒绝：任一条目的路径含空段、`.`、`..` 或反斜杠；条目不在唯一的顶层目录下；保留的路径是链接或出现两次；保留的文件超过 `bytes`；没有许可证文件。Windows 上 node-tar 在 Service 读取路径之前已把反斜杠转成 `/`，因此改为检查它分开的各段。摘要按路径顺序对每个保留文件的路径、字节长度和内容做哈希，因为 GitHub 保证提交归档里的文件不变，但不保证压缩后的字节不变。校验通过的文件先写入同级的暂存目录，再改名为句柄的 `directory`；另一个进程（例如与 Web 同时运行的桌面端）先发布的目录会被保留。

### 替换旧的固定提交

每个由 `dsh` 启动的 profile 为每个插件的文件保留自己的目录 `$DSH_HOME/cache/<name>/<profile>`，这个 profile 的各个进程共用它。一次注册只删除一次该目录下其他固定提交的目录，时机是它自己的固定提交第一次在那里就位时：加载时已在位，或下载完成后。因此插件更新换了固定提交之后只留下一份，新的固定提交发布之前，旧的保持不动。删除在后台进行，`register` 和下载的结束都不等待它；无法删除的目录记为警告，留到之后的加载时再删。由于一次注册只删除一次，某个进程的固定提交被同一 profile 的另一个进程删除后，它在下一次检查时重新下载，并保留那个进程的固定提交；这种情况见[已知限制](#known-limitations-and-deferred-work)。不是由 `dsh` 启动的组合没有 profile：它的固定提交都留在可能被多个安装共用的 `$DSH_HOME/cache/<name>` 中，一个也不删除。配置的 `skillsDir` 及其同级目录从不删除。

### 固定提交

`pnpm exec tsx scripts/upstream-skills-digest.ts --repository <owner>/<repository> --commit <完整提交号> --directory <路径> [--exclude <路径>]... [--license LICENSE] [--url <前缀>]` 从 `--url` 前缀下载归档（默认是 `https://codeload.github.com`），按同样规则保留文件，以 JSON 输出固定信息，并在 stderr 列出保留的 `SKILL.md` 路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`register` 在调用方插件的 context 中运行，因此技能提供方是该插件的 effect，随它一起移除。提供方只在句柄的 `directory` 存在时列出入口技能，来源为 `bundled`、使用内置技能的优先级，因此同名的项目或用户技能优先。发布前它返回完整的空列表，因为不完整的结果会让整个技能目录变成不完整；发布后改为使目录失效；下载失败但发现另一个进程已发布目录时也使目录失效。同一时间只运行一次下载：下载进行中的每次 `install` 调用都等待它，其中任一调用方的 signal 中止都会停止它，卸载插件时，提供方注册的信号也会中止它。保留文件在与摘要一致之前只存在内存中，总量受 `bytes` 限制，因此未经校验的文件不会写入磁盘；选择范围之外的文件读取后即丢弃，花在它们上面的时间受 `skillsTimeoutMs` 限制。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.upstreamSkills` Service、其配置、`register`、提供方与发布 |
| [`src/archive.ts`](src/archive.ts) | 下载、读取归档、路径与大小检查、摘要和写入文件 |
| [`src/types.ts`](src/types.ts) | 固定信息、注册与句柄的类型 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connector 包](../README.zh.md)——这个包和 CLI 应用插件所属的分组。
- [运行时下载上游技能](../../../.agents/notes/implemented/architecture/2026-10-28-upstream-skills-runtime-download.zh.md)——插件为什么下载这些文件，而不是携带副本。
- [Skill registry](../../skill/skill/README.zh.md)——Service 注册每个入口技能时使用的提供方与目录 API。
- [Skill 子系统参考](../../../docs/subsystems/skills.zh.md)——技能如何到达模型。
- [Base bundle](../../bundle/base/README.zh.md)——加载这个 Service 的组合包，以及 profile 如何覆盖它的某一行。

-----

<a id="model-experience"></a>
## 模型体验

间接影响：上游文件发布后，`dsh-tool-skill` 在目录中列出入口技能，并在返回入口正文时以句柄的 `directory` 作为技能的基础目录。没有插件注册时，Service 不向模型请求添加任何内容。

#### KV Cache 影响

加载时文件已在位，入口技能就出现在会话的第一份目录中。下载在第一份目录之后完成时，`dsh-tool-skill` 追加一份包含入口技能的替换目录；之前的请求 token 不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 换用新的固定提交后，首次加载需要能访问 GitHub 或配置的镜像；下载成功之前，入口技能不会列出，账号检查等待这些文件的插件报告下载失败，而不是账号。
- 每个加载该插件的 profile 都各自下载一份固定提交。
- 同一个 profile 的多个进程可以同时运行同一插件的不同版本，例如一个在插件更新之前启动，另一个在更新之后启动。后启动的进程会删除先启动的进程正在读取的固定提交：先启动的进程不再列出入口技能，其中的 Agent 也打不开子指南，直到它下一次检查重新下载完成。此后两个固定提交都保留，直到这个 profile 的某个进程再次加载该插件。
- 移除插件后，它的固定提交仍留在缓存中。进程在写入下载内容时退出，也会在那里留下它的暂存目录 `.skills-<摘要>-<uuid>`。两者都不会被删除。
- 没有 profile 时，插件改为固定其他提交后，所有固定提交都留在 `$DSH_HOME/cache/<name>` 中。
- 只检查已发布的目录是否存在。目录里的文件被删除或改动后，入口技能仍会基于这些文件列出；删除该目录后，下一次检查或加载会重新下载固定的提交。
- 不保留文件权限，上游脚本不可直接执行；目前的上游子指南都通过 `python3` 运行脚本。
- 实验性 Web 预览把 Host 插件运行在浏览器 worker 中：服务可以加载，但 node-tar 无法加载，因此那里的每次下载都会失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
