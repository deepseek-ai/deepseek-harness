---
description: "dsh profile 与临时 Python SDK 运行时的共享 Loader 启动支持：环境层、patch、诊断与配置预览。"
kind: "package-library"
---

# @deepseek-ai/dsh-app-boot

[English](README.md) | 中文

## 概述

`dsh-app-boot` 是 `dsh` profile（包括 Python 运行时 wheel 所打包的 CLI）背后的共享 Loader 启动库。它加载环境层、组合 profile bundle 与 patch、启动每个插件，再返回运行中的应用，或指出失败插件与原因。产品应用使用 `dsh` launcher 而不发布单独 bin；直接配置 helper 只保留给低层嵌入方与测试。你还可以在启动前预览生效配置，按 profile 选择实时或仅启动时应用 patch，并让持有终端的应用在致命退出前恢复终端。

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

用此包启动应用是一个小而显式的入口：你给它一个配置文件，它运行整个启动过程。本节说明你能做什么、能得到什么；每个结果背后的 helper 调用记录在下方可折叠的实现章节中。

### 何时使用

在实现共享 `dsh` launcher 或嵌入其低层启动 helper 时使用它。产品功能应放入 profile bundle，而不是新增应用 bin；只向已运行应用添加插件的代码直接挂载插件即可。

### 启动应用

你把配置文件交给入口，进程就会启动整个应用：加载环境层、应用 patch 与 profile、启动每个插件，并在应用运行后返回。在回放模式下，它会启动同级的 `cordis.snapshot.yml` 替代文件，使已记录的会话能够原样复现。最小的入口只需两次调用：

```text
installFailLoud('dsh')
const ctx = await boot('dsh', resolveConfigPath(argv[2], process.env.DSH_SNAPSHOT))
```

有了这个入口，成功就是每个插件都已激活的运行中应用；失败绝不会悄无声息——一行带标签的信息点名失败的插件与阶段，进程以非零码退出。错误上报前会先拆卸应用上下文，因此不会留下半启动的残留。

<a id="profiles"></a>
### Profile

profile 是同一套 dsh 安装提供不同应用界面的方式：`web`、`headless`、`acp`、`sdk` 与 `sdk-minimal` 从同一 launcher 启动不同组合。profile 位于 `$DSH_HOME/profiles/<name>`，由可安装 bundle、自身 `cordis.patch.yml` 与 `patchReload: live | startup` 组成；自定义 profile 省略 reload 策略时保留历史 `live` 默认值。随产品交付的 `web` 模板实时重载，其他随附模板只在启动时应用 patch。`sdk-minimal` 只列出自身的独立 bundle，其他模板保留 base 加模式 bundle 的栈。`dsh plugin` 创建自定义 profile；缺失 bundle 或未声明 patch 的 bundle 会让启动明确失败。

你的机器本地偏好同样位于 harness home 中：

- **`.env`**——你的普通环境层：调用目录的文件优先于 harness home 的文件，两者都低于继承环境。决定进程如何启动的变量（`PATH`、`DSH_*`、`XDG_*` 等）会被文件拒绝：请改为导出。四个代理名（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`）只从 harness home 的文件接受，绝不从调用目录的文件接受——后者随 clone 一起到来。对于只想加载某个目录 `.env` 的非产品 bin，文件缺失不影响启动，文件无法加载时输出一行带标签的警告。
- **`cordis.patch.yml`**——你的 tweak 层，应用在所有组合包层之后（先应用逐 profile 的文件，再应用 home 级文件，因此后者优先级更高）：替换某个条目的整个 config（重述你要保留的字段）、插入新条目，或在启动时插值 `!!js` 表达式。patch 指定的条目不存在时输出 stderr 警告；空文件或仅含注释的文件会导致启动失败——如需禁用该层，请改用 `[]`。

带 `patchReload: live` 的 profile 会监视两份用户 patch 文件：有效编辑无需重启即可重新组合，被拒绝的编辑则让最后一个可用应用继续运行。`startup` profile 既不安装这些监视器，也不安装 launcher 的仅监视 HMR 回退。

### 预览生效配置

启动前，你可以打印应用将挂载的确切配置：dump 会以 `!!js` 表达式原样展示组合后的条目列表，并按注释分组标明每个源文件及其 patch 层，输出是一份可加载的 YAML 文档。未匹配到任何行的 patch 会连同其层标签一起报告；配置缺失、无法解析或字段无效都会使 dump 失败。

### 启动失败时你会看到什么

启动失败是一行带标签的信息加非零退出码——绝不是静默卡死或原始堆栈倾倒。信息会点名失败的插件；抛错的插件保留原始错误，从未启动的条目会连同它等待的服务一起报告。

如果你的应用持有终端，它可以在进程退出前把终端交还，你的 shell 绝不会残留在 raw 模式。交还过程有界：卡住的清理只会延迟致命退出，而不会取消它。

### 告诉 agent harness 所在位置

当你的应用启动模型驱动的 agent 时，你可以告诉 agent DSH 实现代码 checkout 的位置：它得知该路径，也知道不得据此推断工作目录——它应使用 `pwd`。这条指示在系统提示词靠前位置出现一次。没有系统提示词服务的应用会跳过；开发环境中，重新加载系统提示词后它会消失，直至下次启动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释上述结果如何实现，并指出实现它们的代码位置；这里的内容面向开发者，使用本包并不需要。

### 设计说明

- **与渠道无关的库。** 此包不包含 loader 钩子，也不提供开发模式接口；[`dsh` 应用](../../../apps/cli/README.zh.md) 持有自己的 Node 源码启动钩子，并在启动序列中使用这些 helper，构建后的消费方则使用普通 Node 包解析。
- **两个 Loader builtin。** `mountRootInclude` 把 `cordis:include` 与 `cordis:group` 注册为 Loader builtin：group 行能把一个提供方与它的消费方放进同一个 `isolate` realm，而位于本工作区之外的 agent preset 无法按名称解析 `@deepseek-ai/cordis-plugin-group`。两者都通过宿主的模块管线加载，而非被包含树自身的说明符解析。
- **Profile 模块后备机制。** 裸插件 specifier 由 Loader 从配置目录解析。普通 Node 会为安装依赖闭包中的每个包维护一个符号链接。打包可执行文件无法让操作系统符号链接进入 pkg 的 `/snapshot` 树，因此会按 Node ESM 条件读取已安装包的 export map，并写入重新导出虚拟模块 URL 的真实代理包。缺失 export 保持不可用，错误 export map 会让启动失败，跨进程 writer lock 则会在不暴露部分代理的情况下替换陈旧条目。所选外部 bundle 若不在安装闭包中，则会获得 profile 本地的 `.dsh-module-fallback` 链接；已有 pnpm 条目优先，后续闭包发现会排除投影链接，清理也只删除 dsh 自有链接。
- **单一 rejection 检查点。** `assertEntriesActivated` 把折入启动诊断的确切原因保持到下一个进程级 rejection 检查点可见，使 `installFailLoud` 能合并 Loader 的重复通知，而所有无关的未处理 rejection 仍然致命。
- **两阶段失败标签。** `boot()` 区分 `host preparation failed`（`prepare` 在任何配置树条目挂载前抛出）与 `plugin tree failed to load`（此后的一切失败），并追加最深层插件错误的堆栈，使启动诊断保留原始激活错误，而不只是包装链。

### Helper 行为

每个导出各负责启动的一个阶段：配置解析与快照回放、分层环境加载、明确报错的保护机制、激活审计、patch 解析、根 include 挂载、配置 dump 渲染、活动 patch 监视、profile 组合，以及 harness 源码段落。各导出的约定在代码中，不在本 README——见 [`src/index.ts`](src/index.ts) 与 [`src/profile.ts`](src/profile.ts)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 启动 helper：配置解析、环境加载、会明确报错的保护机制、激活审计、patch 解析、配置 dump、harness 源码段落 |
| [`src/profile.ts`](src/profile.ts) | profile 发现、初始化、组合包解析、模块后备机制 |
| — | 不发布运行时不变式伴生入口；边界与回放测试覆盖其协议映射。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享启动机制逐步进入组合模型及其背后的决策证据。

- [Cordis 入门](../../../docs/cordis-primer.zh.md)——Loader、`!!js` 配置表达式，以及 include/group 语义。
- [dsh 应用](../../../apps/cli/README.zh.md)——消费这些 helper 的 `dsh` bin。
- [dsh-cmdline](../cmdline/README.zh.md)——各 bin 使用的启动器到应用命令行交接。
- [Profile 组合包](../../bundle/README.zh.md)——组合进 `dsh --profile` 的可安装 patch 层。
- [dsh-home-paths](../../util/home-paths/README.zh.md)——harness home 解析器（`resolveDshHome`）。
- [配置来源归属](../../../.agents/notes/implemented/architecture/2026-08-04-configuration-source-ownership.zh.md)——被发现的文件为何不得决定 bootstrap 行为。
- [Profile 插件组合包](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与组合包组合设计。

-----

<a id="model-experience"></a>
## 模型体验

模型通过此包加载的插件树间接受影响——只有该树贡献模型上下文；唯一贡献模型可见文本的导出 `addHarnessSourceSection`，也只有在消费方启动后调用它时才会产生影响。

#### KV Cache 影响

启动本身不会使请求前缀中的任何内容失效。消费方调用 `addHarnessSourceSection` 时，会在系统提示词靠前位置、逐请求内容之前添加一行短文本，因此不会使跨轮次缓存失效；请求前缀的其他任何变化均由相应的具名消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明此启动库在何时不合适，或何时需要特别注意。它们是当前包约束，不是任务积压。

- **裸包 specifier 依赖 Loader 内部机制**——生产 bin 需要 Loader 的可选原生辅助组件；没有该辅助组件的进程内调用方必须使用可解析的相对／file specifier，或提供自己的模块解析钩子。
- **快照回放替换仅识别特定 basename**——只有以 `cordis.yml` 或 `cordis.yaml` 结尾的配置会映射到同级 `cordis.snapshot.yml`；自定义配置名称需要调用方自行选择。
- **环境发现以启动为界**——`loadLayeredEnv` 只读取一次调用目录与 harness home 中的 `.env`；它不搜索父目录，也不跟随之后选择的 workspace。`loadEnv` 仍是非产品 bin 使用的单目录 helper。
- **用户 patch 会替换匹配到的整个配置**——按 id 定位的 patch 不做深度合并，因此 profile 覆盖必须重述需要保留的组合包字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 待定：配置 dump 稳定性

`renderConfigDump` 的输出是一份可加载的 YAML 文档，其 `# ==` 来源注释与 `!!js` 原样渲染服务于 `--dump-config` 诊断。任何内容都不承诺跨包版本的字节稳定性；在程序化消费该输出之前，请决定 dump 是否成为序列化约定。

</details>
