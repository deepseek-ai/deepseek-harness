---
description: "按 preset cordis.yml 文件进行按会话的 agent 组装，供选择、配置或排查 agent preset 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-presets

[English](README.md) | 中文

## 概述

`dsh-agent-presets` 让每个 agent（智能体）会话都从同一个 preset 组装：preset 是一个目录，内含一份 `agent.cordis.yml`，列出该会话运行的插件。命名某个 preset 的会话会获得该 preset 的工具、提示词段落与 skill（技能），而其他会话各自保持自己的，因此一个进程可以同时运行多个组装方式不同的 agent。本包维护 preset 名单：它列出已配置根目录提供的每个 preset——随附的与你自己放在 `<dshHome>/.agent-presets` 下的——在 preset 无法启动会话时给出原因，并允许你通过复制既有 preset 来创建新 preset。默认 preset 是一项可按部署或按用户覆盖的设置，会话只有在尚未产出任何内容时才能切换 preset。preset 的权限恰好等于它所引用插件的权限，因此你创作的 preset 与 shell 访问权限同级。

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

在需要让每个 agent 会话从 preset 文件获得自己的工具、提示词段落与 skill 的组装中挂载本包。每个会话都会命名一个 preset——显式指定或通过配置的默认值——并据此组装；没有本包时，会话只能回退到宿主组装挂载的内容。

### preset 给会话带来什么

从 preset 组装的会话会运行该 preset `agent.cordis.yml` 所列插件：它的工具、提示词段落与 skill。加入同一 preset 的会话共享一份已安装的组装，且各会话的状态彼此隔离。子 agent（subagent）会加入其父方的组装，因此它看到的工具与提示词段落和创建它的 agent 相同。

可选的 preset 来自两处：本包 `presets/` 下随包交付的 preset，以及你自己放在 `<dshHome>/.agent-presets` 下的 preset。选择器会展示每个 preset 的显示名与描述；组装无法加载的 preset 会连同原因一起列出而不是被隐藏，因此你能看到该修什么或删什么。

### 最小配置

插件需要一个 `default` preset id，并在 `roots` 中扫描 preset：

```yaml
- name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    roots:
      - path: ~/company-presets
        trust: system
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `default` | 必填 | 会话未指定时组装的 preset id |
| `roots` | `[]` | 按优先级排列的扫描目录；每项提供 `path`（开头的 `~` 会展开）与 `trust`（默认为 `user`） |
| `includeShippedRoot` | `true` | 在全部已配置根目录之前，前置本包随附的 preset 作为 `system` 根目录 |
| `includeUserRoot` | `true` | 在全部已配置根目录之后追加 `<dshHome>/.agent-presets` 作为 `user` 根目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-presets)是每个受支持字段及其 JSDoc 的穷尽式真源。

随附根目录前置在全部已配置根目录之前，因此即使补丁替换 roster 配置，内置集合仍然可用并赢得重复 id。`includeShippedRoot: false` 会为完全自行提供 preset 的部署移除内置集合。`includeUserRoot: false` 会移除推导出的可写根目录；钉住确切 roster 的测试会同时关闭两个推导根目录。

### 选择默认 preset

`default` 配置设定部署级默认值。当组装中存在 settings 提供方时，本插件会注册 `agent-presets` 命名空间，并以 `config.default` 作为其 base，因此用户文档会在部署默认值之上层叠一份按用户设置的默认值：

```yaml
agent-presets:
  default: minimal
```

该值在会话创建时读取，因此更改默认值只影响此后创建的会话；运行中的会话仍停留在它们当初据以组装的 preset 上。清空用户字段即重新继承组装默认值。

### 创作 preset

创作即复制：创建 preset 会复制某个既有 preset 的整个目录——组装、展示元数据、skill 目录与资产——放进第一个 `user` 根目录。副本保留来源的描述，但拥有自己的 id 与可选显示名，因此调用方从不提供组装文本，一次复制也不会授予名单尚未携带的任何能力。创建之后的一切都发生在 preset 自己的文件里。

以下情况会拒绝复制：id 不符合 `[a-z0-9][a-z0-9-]*`（id 会成为目录名）、id 已被占用（复制从不覆写）、或来源未知。删除只移除本地创作的 preset；随部署提供的 preset 不可删除。已在被删除 preset 上运行的会话会继续运行。

### 切换会话的 preset

会话只有在尚未产出任何内容——没有消息或工具调用——时才能切换到不同的 preset。此后组装在会话的生命周期内固定，因为在对话中途调换工具会留下新组装无法执行的已记录工具调用。已提交的切换会发出 `tools/change`，因为解析后的工具集在没有注册表编辑的情况下发生了变化。切换也会记入会话日志，因此恢复或 fork 的会话会按它运行的组装重建。

### 失败与恢复

组装缺失、无法解析、不是具名插件行列表，或者引用了无法解析的模块的 preset 会被列为 broken，原因会指名出问题的行；组装此类 preset 会被提前拒绝，因此会话绝不会以半组装状态启动。能活到会话创建的，是模块能加载但随后拒绝的行——抛错的插件，或等待组装从未提供的服务的插件——它会让创建失败并回滚，且会指名每一个失败的行，包括组内的行。修复 preset 的文件或删除它，然后重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释名单与常驻挂载背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **每个 preset 一份常驻组装。** preset 在进程内只挂载一次，挂到常驻 scope 之下；agent 通过把自己的 scope key 认父到该挂载来加入，因此挂载的注册与监听器覆盖每个已加入的 agent，而不覆盖兄弟 preset 的。
- **代际以组装文件为键。** 挂载记录组装文件的 stamp（mtime 与大小）；发现 stamp 过期的会话会开启下一个代际，而已加入的会话保持各自运行的那个代际——运行中的会话在文件被修改或删除后继续存活。
- **preset 文件是输入，绝不是持久化目标。** 被挂载的子树把 `write()` 覆写为空操作，因此 loader 发起的写回绝不会重写共享的 preset 文件。
- **发现过程拥有健康。** 组装缺失或不可加载的目录是携带原因的 broken 名单行，而不是被跳过——被跳过的目录仍占着它的 id，而任何界面都没有可删的东西。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：`Config` schema、settings 命名空间、名单 API、常驻挂载协调 |
| [`src/discovery.ts`](src/discovery.ts) | 文件系统发现：根目录扫描、健康检查、id 校验、排序 |
| [`src/composition-inventory.ts`](src/composition-inventory.ts) | 面向插件清单表面的压平组合行：文件读取（求值 disabled 门）与挂载读取（携带 fiber 状态） |
| [`src/preset.ts`](src/preset.ts) | 词汇体系：preset id 规则、`AgentPreset` 与 `PresetRoot`、错误类型 |
| [`src/mount.ts`](src/mount.ts) | 子树挂载、宿主 base-URL 处理、挂载审计、`write()` 抑制 |
| [`src/authoring.ts`](src/authoring.ts) | 本地创作 preset 的复制/删除/读取、权限收紧 |
| [`src/metadata.ts`](src/metadata.ts) | `preset.yml` 展示元数据 |
| [`src/session.ts`](src/session.ts) | `agent-preset/selected` 事件与 `agentPreset` Session 投影 |
| [`src/types.ts`](src/types.ts) | client-safe 的线上载荷与 cordis 事件声明 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：挂载后的服务泄漏复查、未加入 agent 的失败 |

### 常驻挂载

`ensureStanding` 为每个 preset id 保留一个进行中的 promise（single-flight），因此两个竞争首次使用同一 preset 的 agent 共享一份组装。已结算的失败会被移除，以便后续会话重试文件已被修复的 preset。挂载运行在 roster 服务自己的未追踪上下文中——从被追踪上下文派生的子树会经调用方的 shadow fiber 解析服务——因此它比任何 agent 都活得久，只随整棵树卸载。`serviceForAgent` 读取某 agent 对其 preset 挂在 `isolate` realm 之后（组外不可见）的某个服务实例。

### 组合清单

`compositionInventory()` 向插件清单表面提供每个预设的压平行及其名单身份（id、trust、显示名、默认标记）：已有存活 standing mount 的预设由其最新世代的 Loader 条目作答——匹配限定在本运行时自己的 root 内，同进程里的第二个 Cordis 运行时不会替它作答；即使文件事后损坏也照常作答，因为挂载才是会话实际运行的组合，broken 裁决只适用于无人组合的预设——开机以来从未被组合的预设由其组合文件作答，`!!js` disabled 门用 Loader 上下文求值，使两种答案反映同一台宿主。读取从不挂载预设——列出所有组合的设置页不会激活其中任何一个。求值器拒绝的门保持 `'conditional'`；在发现的健康裁决与行读取之间变得不可读的文件，会携带竞态原因报告为 broken，而不是被静默丢弃。`./display` 子路径导出 `presetDisplayText` 纯函数，把内置预设 id 映射到各自的字典文案键；它没有任何 import，浏览器包直接内联，也是「哪个内置 id 对应哪份文案」的唯一归属地。

### 挂载审计

直接挂载的子树不会出现在 `ctx.loader.entries()` 中，因此没有启动审计能覆盖它；`mountPreset` 自行证明结果可用，并拒绝三种形态：无 scope 的目标（preset 的工具会注册成全局的）、仍在等待组装从未提供的服务的行、以及把服务发布进根 realm 的行（进程级全局，第二个发布同名服务的 preset 会相撞）。不变式伴生插件在每次服务通知时复查最后一条规则，因为从定时器或异步续体发布的行会绕过一次性审计。

### 创作机制

复制会解引用符号链接以保证自包含，把目录树收紧为仅属主可用（文件 `0o600` 并保留属主执行位，目录 `0o700`），并在首次复制时创建根目录。复制出的 `preset.yml` 会被重写：保留来源的描述供作者编辑，丢弃其名称与 roster `order`，从而让名单始终能区分副本与来源。删除拒绝随部署提供的 preset，并清除指向刚删除 preset 的用户默认值。

### 会话记录

创建 header 记录会话启动时使用的 preset；`agentPreset` Session 投影记录会话运行时使用的 preset。切换在替换提交后追加 `agent-preset/selected` 事件，因为 preset 决定模型看到的工具 schema 与提示词段落。服务把这项已提交事实重新发为不带 scope 的 cordis 事件 `agent-preset/selected(sessionId, agentPreset)`。重建消费该投影；投影从创建 header 开始并应用最新选择，绝不单独折叠日志。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从组装模型逐步进入挂载所依赖的 scope 与提示词机制，以及决策证据。

- [persona 包](../persona/README.zh.md)——preset 挂载的可组装行，让会话拥有自己的人设。
- [Scope 子系统](../../../docs/subsystems/scope.zh.md)——scope key 与 agent 加入所经由的父链。
- [系统提示词子系统](../../../docs/subsystems/system-prompt.zh.md)——preset 提示词段落如何注册与组装。
- [会话包映射](../../session/README.zh.md)——preset 切换所追加的持久会话记录。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-presets)——每个受支持配置字段及其源声明。
- [按会话组装 agent preset 的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.zh.md)——设计理由与备选方案。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 preset 常驻组装安装的插件：这些插件拥有该 preset 向加入它的 agent 呈现的每个工具 schema、提示词段落与 skill。

#### KV Cache 影响

在一个 agent 的整个生命周期内保持前缀稳定：组装只装入一次，发生在 agent 发布之前、因而也在它的首个请求之前，且在 agent 运行期间不再重新读取。为新会话选择不同的 preset，只会为该会话建立不同的前缀，无法让任何已在运行的会话失去缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明名单何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用组装对比或任务积压。

- **位于可写根目录之外的 preset 可被发现却无法删除**——`remove()` 拒绝任何不在第一个 `user` 根目录下的 preset，因此一个既配置了自有可写根、又保留 `includeUserRoot` 的部署，会列出并挂载 harness home 下的 preset，却对每次删除回答「它不在可写 preset 根目录之下」。只想要自有 preset 的部署应设置 `includeUserRoot: false`。
- **会话一旦产出任何内容便无法更换 preset**——切换会把空白会话的父作用域重链到另一个常驻挂载，且仅限空白会话：在对话中途调换工具会抽走模型已调用的工具。
- **代际只以组装文件为键**——stamp 检查只察觉 `agent.cordis.yml` 的变化，察觉不到旁边 skill 文件或资产的编辑；那些编辑要等组装文件本身变动或进程重启才达到新会话。
- **被替代的代际永不回收**——已加入的会话保持其运行所在的代际，而名单没有加入计数可以判断最后一个何时离开，因此整棵子树一直挂到进程结束。代价按代际计而非按会话计，但并非为零：`dsh-skill-filesystem` 默认监听自己的根目录，因此每一轮「编辑后建会话」都会新增一套活的 watcher。
- **副本从不被实际挂载以校验**——它与来源逐字节相同，因此磁盘上已坏的来源会产出与来源同样损坏的副本；发现过程的健康检查会在下一次读取名单时把两行都标出来，而不是把失败推迟到会话启动。
- **健康问的是「装没装」，不是「能不能 import」**——发现过程证明组装能以加载器方言解析、由具名行组成，且每一行它能证明会启动的行所引用的包装在 harness 基准之上、或所引用的文件确实存在；它从不 import 任何一个，因此入口文件缺失的包、在 apply 时抛错的插件、以及永远等待某个服务的插件，都仍在第一个会话处失败。`disabled` 是加载器唯一会插值的条目字段，因此在该字段写了表达式的行会被跳过，而不是仅凭文件下判断。
- **副本是会漂移的快照**——升级部署不会更新随附 preset 的副本，本层也没有表达「standard 加一处改动」的 patch 语义；随附集合自己也接受同样的代价——`cordis` 与 `code` 都复制了 `standard` 的完整组装并在此基础上编辑——换来整份组装在一个文件里可读。
- **根目录扫描不做监听**——每次读取都实际访问文件系统，这让名单保持新鲜，但每次 `list()` 会对每个根目录产生一次 `readdir`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：回收被替代的代际

回收被替代的常驻挂载，需要给 `StandingMount` 加上已加入 agent 的计数，在 `mount`/`composeFrom`/`recompose` 中递增、在 agent 的 scope key 消亡时递减——即 `ensureStanding` 处的 `TODO`。子树并非惰性：`dsh-skill-filesystem` 监听自己的根目录，因此未回收的代际会让一套活的 watcher 一直存活到进程结束。

</details>
