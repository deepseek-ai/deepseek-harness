---
description: "本地文件系统 skill 提供方，供编写本地 skill、或配置项目、自定义与用户 skill 根目录如何被发现与监视的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-filesystem

[English](README.md) | 中文

## 概述

agent（智能体）可以使用来自仓库、自定义目录或用户 agent 配置的本地 skill（技能）：把 skill 编写为任一被扫描根目录下的目录 bundle（内含 `SKILL.md`）或平铺 `<name>.md` 文件，它就会出现在会话目录中。该提供方发现项目、自定义与用户根目录，解析每个 skill 的 YAML frontmatter，并监视这些目录，因此新增、改名或删除的 skill 无需重启即可到达 agent。当 skill 存放在磁盘上时选择它——注册表（`dsh-skill`）接受任意提供方，其他提供方可以从别处提供 skill。

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

挂载插件即可让本地 skill 对 agent 可用。它扫描下方的项目、自定义与用户 skill 根目录，把每个 skill 的 frontmatter 解析为目录条目，并按需加载正文；它还会监视这些根目录，使新增、改名或删除的 skill 无需重启即可进入下一次目录。

### 何时选择

当 skill 存放在磁盘上——仓库、自定义目录或用户的 agent 配置中——时，使用此提供方。当 skill 来自远程注册表或嵌入式插件数据时，请避免使用：注册表接受任意提供方，本包只是其中一种实现。

### skill 格式

skill 可以是被扫描根目录顶层的目录 bundle `<name>/SKILL.md`，也可以是平铺文件 `<name>.md`；刻意不支持发现嵌套的 `**/SKILL.md`。文件以 YAML frontmatter 开头：必填 `name` 与 `description`，另有可选 `whenToUse`、`metadata`、`disable-model-invocation` 与 `user-invocable`。

`disable-model-invocation: true` 会把 skill 从面向模型的目录和 loader 中排除；`user-invocable: false` 会把它从面向用户的命令中排除，省略的字段默认允许对应接口调用。这两个键接受 YAML 布尔值，以及不区分大小写的 `true`/`false`、`yes`/`no`、`on`/`off` 和 `1`/`0` 形式；被拒绝的拼写或非布尔值会让整个 skill 随警告一起被丢弃，而不会静默允许某个接口。

目录与正文具有独立的生命周期：发现阶段把 frontmatter 解析进目录条目，每次加载都会重新读取当前文件，因此编辑 skill 正文无需版本化或缓存失效。

### 根目录与优先级

默认根按该提供方的 rank 顺序扫描：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |

项目根目录是包含 `.git` 的最近祖先目录；如果不存在，则使用当前 cwd。用户 DSH 根目录会跳过其 `.system` 子目录。`includeDefaultRoots: false` 会省略项目根、用户根以及 `$DSH_BUNDLED_SKILL_DIR` 默认值，使隔离提供方只看到自身配置的根；`bundledSkillDir` 会按 rank 600 添加一个内置根目录。

### 挂载与配置

与 skill 注册表一起加载该插件；它需要 `ctx.skills`。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `filesystem` | 注册到 `ctx.skills` 的唯一提供方名称 |
| `includeDefaultRoots` | `true` | 在 `customSkillDirs` 周围包含项目根与用户根 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Harness 配置根目录；扫描其 `skills` 子目录 |
| `agentsHome` | `$DSH_AGENTS_HOME` 或 `~/.agents` | 为兼容 skill 扫描的共享 agent 配置根目录 |
| `customSkillDirs` | `[]` | 其他本地 skill 根目录，位于项目根之后、用户根之前 |
| `watch` | `true` | 监视本地根，并在目录可能变化时使提供方失效 |
| `bundledSkillDir` | — | 配置后按 rank 600 扫描的内置 skill 根目录 |

其余 `watch*` 字段用于调节 Chokidar 行为——轮询、稳定窗口、间隔、项目上限与符号链接跟随。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-skill-filesystem)是每个字段的穷尽式真源。

### 变更检测

现有根目录会被监视，因此新增、改名或删除 skill（或编辑其 frontmatter）会在下一个模型步骤触发目录刷新；`references`、`scripts`、`assets` 等 bundle 资源下的编辑不会触发。当第一方 `write` 与 `edit` 工具的目标可能影响受监视的 skill 时，它们会直接使提供方失效，因此模型无需等待宿主 watcher 即可观察到自身的文件系统变更。外部 IDE、Git 与 shell 变更由宿主 watcher 捕获；尚不存在的根目录会被探测，直至其出现。

### 可观察的成功与失败

任一被扫描根目录下的有效 skill 都会按名称排序出现在会话目录中，加载它即可返回当前文件正文。缺少有效 frontmatter、名称无效或调用值无效的文件会随警告被跳过，因此模型目录不会收到逐 skill 诊断，也无法区分缺失的 skill 与无效的 skill。意外的发现或读取失败会让目录观测保持不完整，而不会用看似发生删除的结果替换最后一份可用视图。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释发现与监视如何组织；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方建立在两个分离之上。第一，目录与正文分离：发现阶段把 frontmatter 解析为摘要，而每次加载都重新读取文件，因此正文编辑无需 hash、修订号或缓存失效。第二，发现与监视分离：`list()` 在存在文件系统服务时通过 `ctx.fs` 扫描根目录并解析项目根（否则回退到可中止的 Node I/O），而独立的监视管理器负责 Chokidar 句柄、缺失根探测与失效。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、提供方、根解析、frontmatter 解析、监视管理器 |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

### 发现流程

发现过程先为查找 cwd 解析根列表，让监视管理器附加到每个根，再扫描每个根的直接条目：目录 bundle 解析为 `<name>/SKILL.md`，平铺文件解析为 `<name>.md`。每个文件都会解析 frontmatter——`name` 必须为 kebab-case，`description` 必填，调用键按严格布尔语法解析——候选项携带根目录的来源标签与 rank，供注册表与其他提供方合并。已确认缺失的路径属于有效空状态；格式错误或非文本条目会随警告跳过。

### 监视与失效

现有根目录由 Chokidar 以深度 1 监视；不存在的根会从最近的现有祖先开始，借助 `fs.watchFile` 每次沿一个缺失路径段跟踪。相关事件——直属 bundle 添加/移除、平铺 `.md` 添加/移除、直接 `SKILL.md` 添加/移除/变更——会在每个微任务批次合并为一次提供方失效，资源子树下的变更则被忽略。监视管理器受 `watchMaxProjects` 限制，会记录并重试失败的启动，并在释放时关闭所有句柄。第一方 `write`/`edit` 变更通过 `fs/observed` 事件同步失效。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从注册表约定逐步进入渲染已发现 skill 的消费方，以及配置默认值使用的 home 路径解析。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——注册表约定与本地发现优先级表。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表。
- [tool-skill 包](../tool-skill/README.zh.md)——已发现 skill 如何到达会话目录与模型。
- [home-paths 包](../../util/home-paths/README.zh.md)——`dshHome` 与 `agentsHome` 如何解析。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；它把该提供方的可调用名称和有长度上限的描述渲染到初始目录或替换目录中，并把所选的当前指令正文与资源基底指引渲染到已保留工具历史中；路径、提供方 rank 与已禁用 skill 仍被隐藏。

#### KV Cache 影响

watcher 触发的失效可促使上述消费方在现有请求历史中追加替换目录。仅涉及正文的编辑不会改变目录 digest。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **发现深度为一层**——只识别 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`；忽略嵌套 skill 树与包 manifest（元数据清单）。
- **项目范围为最近 `.git` 祖先**——没有该标记的工作区回退到提供的 cwd，不支持其他项目根标记或 monorepo 子项目选择。
- **格式错误的条目随警告消失**——模型目录不会收到逐 skill 诊断，无法区分缺失的 skill 与无效的 skill；意外的 I/O 失败则会保留最后一份可用目录。
- **缺失根观察每次轮询一个路径段**——启动时不存在的根会使用 `fs.watchFile` 按 `watchPollIntervalMs` 轮询，直至 Chokidar 可以附加；这以有界检测延迟换取跨 IDE、Git 与 shell 工作流的可靠创建检测。
- **无正文修订协议**——已加载正文是普通的已保留工具历史；后续文件编辑会影响后续调用，但既不会改写旧结果，也不会通知正文已变化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制以上文和代码为准。`src/index.ts` 中的一条 TODO 提议把 Chokidar 与缺失根观察提取为 Cordis 文件监视服务，把 skill 过滤与失效保留在此处；上文记录的缺失根轮询取舍是该开放设计的一部分。

</details>
