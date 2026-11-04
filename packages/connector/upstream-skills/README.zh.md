---
description: "为 CLI 应用插件的入口技能，从厂商 GitHub 仓库固定提交的一个目录下载它索引的上游文件，校验后发布到 DSH 缓存，再在这些文件之上列出入口技能。"
kind: "package-library"
---

# @deepseek-ai/dsh-upstream-skills

[English](README.md) | 中文

## 概述

企业微信、腾讯会议等 CLI 应用插件用这个库获取厂商只在自己 GitHub 仓库里发布的子指南。插件保留自己的入口 `SKILL.md`，并按提交、总大小和摘要固定该仓库的一个目录。插件加载时，`registerUpstreamSkills` 下载这个提交的归档，保留该目录和许可证文件，校验后发布到 DSH 缓存，再列出入口技能，并把发布目录作为它的基础目录。仓库和插件的 npm 包里都没有上游文件的副本。

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

### 何时使用

上游技能只存在于厂商 GitHub 仓库的 CLI 应用插件，在 Host 一侧使用它，让每台用户电脑在运行时从厂商处下载这些技能。CLI 内嵌子指南的插件通过 CLI 读取它们，如飞书；发布包里附带带校验和的技能归档的插件，把它和可执行文件一起下载，如钉钉。

### 入口

插件固定上游文件，把共用配置字段加入自己的 `Config`，并在加载时注册入口技能：

```ts
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { registerUpstreamSkills, type UpstreamSkillsConfig, type UpstreamSkillSet } from '@deepseek-ai/dsh-upstream-skills'
import type {} from '@deepseek-ai/dsh-skill'

declare const ctx: Context
declare const config: UpstreamSkillsConfig

const VENDOR_SKILLS: UpstreamSkillSet = {
  repository: 'vendor/vendor-cli',
  commit: '0123456789abcdef0123456789abcdef01234567',
  directory: 'skills',
  exclude: [],
  license: 'LICENSE',
  bytes: 1_754_686,
  sha256: 'c75045cc5297d5886c8a7ff01c993a782e50cbd4aa6f6559394b695157d52e10',
}

const skills = registerUpstreamSkills(ctx, {
  name: 'vendor',
  entry: fileURLToPath(new URL('../skills/vendor/SKILL.md', import.meta.url)),
  set: VENDOR_SKILLS,
  config,
})
```

`registerUpstreamSkills` 从入口的 YAML frontmatter 读取名称和描述，以 `name` 注册一个技能提供方，文件不在位时开始下载。`skills.directory` 是 `skillsDir`，或 `$DSH_HOME/cache/<name>/skills-<摘要前 16 位>`。下载进行中时 `skills.state` 为 `downloading`，否则这个目录存在时为 `installed`，不存在时为 `failed`。`skills.watch(listener)` 报告每次下载的开始和结束；`skills.retry()` 在失败后开始新的下载，并立即返回。插件在账号旁显示这个状态，并在检查中调用 `retry()` 而不等待，因此下载再慢也不会占住账号操作。下载失败会记为警告。卸载插件会中止下载、移除提供方并停止通知。入口正文按仓库路径引用上游文件，例如 `skills/<子指南>/SKILL.md`。以 [`src/index.ts`](src/index.ts) 和 [`src/types.ts`](src/types.ts) 中的约定为准。

### 保留的文件与校验

库按顺序从每个 `skillsUrls` 前缀下载 `<前缀>/<owner>/<repository>/tar.gz/<commit>`。某个前缀返回错误状态或空响应体、没有在 `skillsTimeoutMs` 内送达完整归档、发来损坏的归档，或发来的文件与固定信息不符时，记录它的来源并尝试下一个；卸载插件则立即停止。库保留 `directory` 下除 `exclude` 列出的路径之外的所有普通文件，以及 `license`，并保持它们的仓库路径。以下归档会被拒绝：任一条目的路径含空段、`.`、`..` 或反斜杠；条目不在唯一的顶层目录下；保留的路径是链接或出现两次；保留的文件超过 `bytes`；没有许可证文件。Windows 上 node-tar 在库读取路径之前已把反斜杠转成 `/`，因此改为检查它分开的各段。摘要按路径顺序对每个保留文件的路径、字节长度和内容做哈希，因为 GitHub 保证提交归档里的文件不变，但不保证压缩后的字节不变。校验通过的文件先写入同级的暂存目录，再改名为 `skills.directory`；另一个进程（例如与 Web 同时运行的桌面端）先发布的目录会被保留。

### 固定提交

`pnpm exec tsx scripts/upstream-skills-digest.ts --repository <owner>/<repository> --commit <完整提交号> --directory <路径> [--exclude <路径>]... [--license LICENSE] [--url <前缀>]` 从 `--url` 前缀下载归档（默认是 `https://codeload.github.com`），按同样规则保留文件，以 JSON 输出固定信息，并在 stderr 列出保留的 `SKILL.md` 路径。

### 共用配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillsDir` | 无 | 按仓库路径存放保留文件的目录；设置后不下载，路径不是目录时加载失败 |
| `skillsUrls` | `['https://codeload.github.com']` | 按顺序尝试的 HTTPS 归档下载前缀，不含查询串、片段或凭据 |
| `skillsTimeoutMs` | `120000` | 一个前缀送达完整归档的时限，超时后尝试下一个 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

提供方只在 `skills.directory` 存在时列出入口技能，来源为 `bundled`、使用内置技能的优先级，因此同名的项目或用户技能优先。发布前它返回完整的空列表，因为不完整的结果会让整个技能目录变成不完整；发布后改为使目录失效。同一时间只运行一次下载，卸载插件时，提供方注册的信号会中止它。保留文件在与摘要一致之前只存在内存中，总量受 `bytes` 限制，因此未经校验的文件不会写入磁盘；选择范围之外的文件读取后即丢弃，花在它们上面的时间受 `skillsTimeoutMs` 限制。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 共用配置字段、注册、提供方与发布 |
| [`src/archive.ts`](src/archive.ts) | 下载、读取归档、路径与大小检查、摘要和写入文件 |
| [`src/types.ts`](src/types.ts) | 固定信息与句柄的类型 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connector 包](../README.zh.md)——这个库和 CLI 应用插件所属的分组。
- [运行时下载上游技能](../../../.agents/notes/implemented/architecture/2026-10-28-upstream-skills-runtime-download.zh.md)——插件为什么下载这些文件，而不是携带副本。
- [Skill registry](../../skill/skill/README.zh.md)——这个库实现的提供方与目录 API。
- [Skill 子系统参考](../../../docs/subsystems/skills.zh.md)——技能如何到达模型。

-----

<a id="model-experience"></a>
## 模型体验

间接影响：上游文件发布后，`dsh-tool-skill` 在目录中列出入口技能，并在返回入口正文时以 `skills.directory` 作为技能的基础目录。

#### KV Cache 影响

加载时文件已在位，入口技能就出现在会话的第一份目录中。下载在第一份目录之后完成时，`dsh-tool-skill` 追加一份包含入口技能的替换目录；之前的请求 token 不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 换用新的固定提交后，首次加载需要能访问 GitHub 或配置的镜像；下载成功之前，入口技能不会列出，插件显示 `failed` 状态。
- 插件改为固定其他提交后，以及插件卸载后，已发布的目录仍留在 `$DSH_HOME/cache/<name>` 中，没有任何清理。进程在写入下载内容时退出，也会在那里留下它的暂存目录 `.skills-<摘要>-<uuid>`。
- 只检查已发布的目录是否存在。目录里的文件被删除或改动后，入口技能仍会基于这些文件列出；删除该目录后，下一次检查或加载会重新下载固定的提交。
- 不保留文件权限，上游脚本不可直接执行；目前的上游子指南都通过 `python3` 运行脚本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
