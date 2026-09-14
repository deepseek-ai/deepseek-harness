---
description: "面向无密钥 profile 测试的会话日志快照支持：manifest（元数据清单）、身份脱敏、规范化、workspace 检查与协议适配器。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-snapshot

[English](README.md) | 中文

## 概述

`dsh-session-snapshot` 提供无密钥已记录会话测试（`pnpm run test:snapshot`）背后的共享支持：封闭 manifest、类型化身份脱敏、规范化、workspace 比较、fixture（测试前置数据）保护，以及 headless、SDK、ACP（Agent Client Protocol）与 Web owner 使用的协议适配器。ACP 适配器以真实子进程启动被测 profile，驱动确定性输入脚本，并注册完整的录制、回放与刷新套件。每个场景都提交足够证据来证明模型可见输出与文件系统效果，不依赖 agent（智能体）自述。包入口会导入 vitest，因此只能在 vitest 运行中使用。

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

本包把随附 profile 场景变成无密钥快照套件：写一张场景表和一个 fixture 目录，调用一次匹配的适配器，工具包就负责启动或组合 profile、驱动场景、比较规范化输出并守护已提交的 fixture。

### 编写快照套件

消费方 `*.snapshot.ts` 就是场景表加一次工厂调用。`AgentUnderTest` 提供绝对 `binScript`、可选 `libBinScript`、`configPath` 与 `tsconfigPath` 路径，因为子进程 cwd 位于仓库之外：

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
]

defineAcpSnapshotSuite({
  agent: { // absolute paths, resolved from the suite's own location
    binScript: fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    profile: 'acp',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS, // exactly one entry per header class sets pinsHeader
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
```

每个已记录 Session 目录携带封闭的 `snapshot.yml` manifest，以及规范 parent 与连续 child 角色。parent 文件名是 `session[.vN].jsonl`；child 是 `session.<ordinal>[.vN].jsonl`；v0 省略 `.v0`，正版本使用小写 `.vN`，且每个文件名与其 header 一致。一个角色可以保留旧 generation，但 harness 会选择数值最高的一项。拥有 fixture 的 manifest 可以声明 `sessionFormat.version` 与一个或多个封闭 `coverage` 名称，把该历史 generation 保留为显式迁移 fixture；省略此字段时跟随当前 writer。manifest 还会指名场景、随附 profile、组合／header 类别、录制来源，以及已完成 Session 无法重建的 replay、平台、权限、环境、workspace 或输入事实。存储保护检查每个选定 parent 与 child 角色的工具结果和可移植路径。提示词／schema 擦除、消息身份及提示词先于请求的顺序检查适用于当前 generation；保留的前代维持其历史表示。适配器注册预期输出、Session 日志与可选 `workspace.expected/` 比较；保护会拒绝遗留目录、缺失角色、非规范名称、绝对路径、格式错误的 manifest 与平台专用分隔符。

`normalizeSessionSnapshot` 在规范化路径并擦除系统提示文本与工具 schema 后，会保留完整 Session header 与事件 payload，但从已提交 fixture 中省略顶层 `seq`/`time` envelope；它还会规范化嵌入式 stream clock 与历史 packed-row 的 `seq0`/`time0` envelope 与 catalog child 创建时钟。事件顺序与来源事件引用保持不变。Replay 只在内存中合成顶层 envelope，而运行时持久化仍写入完整日志。多 Session 比较会先通过严格的构建期静态 Session 格式目录校验预期日志与收集日志，再进行身份脱敏与规范化；来源文件名不能改变格式校验。保留的历史 replay 输入不是原生当前格式 writer 输出的比较基准：结构迁移保留请求含义，但可以产生不同的事件布局。归一化保留意外的 request-header 字段（包括 `system`），使回归保持可见。无版本的协议适配器单元测试 fixture 不属于已发布 Session 格式语料。[当前写入器格式](../../../docs/session-format-status.zh.md)的 fixture 每个事件占一行；保留的 v0/v1 fixture 可以使用规范 packed row。[临时仓库迁移器](../../../scripts/migrate-packed-session-fixtures.ts)（`pnpm run migrate:packed-session-fixtures`）会改写更旧的历史布局，由其[移除提案](../../../.agents/notes/proposed/process/2026-07-26-remove-packed-session-fixture-migrator.zh.md)负责删除该迁移器。

spill 场景通过真实本地提供方保存到私有临时根目录。fixture 适配器提供固定长度的逻辑定位符，并仅将本次运行已保存的定位符映射回实际文件以供检索，在不写入共享逻辑路径的情况下保留预览预算。已知的快照 spill 路径会规范化为稳定的定位符 token，包括 JSON 省略通知中带引号、使用 JSON 转义 Windows 分隔符的路径。刷新提取会保留匹配路径的序列化写法，以便进行字面替换。规范化只改变定位符：保存字节数与省略计数仍作为比较证据。

保留历史输入的场景保持规范 Session 文件不变，并继续选择它们进行回放；固定历史版本的目录中没有更新的规范同角色文件。其精确的规范化原生当前格式输出单独记录在父会话的 `writer.expected.jsonl` 和子会话的 `writer.<ordinal>.expected.jsonl` 中；这些是输出比较基准，而非 replay 代际。保留历史输入的 SDK 场景使用 `notifications.current.expected.jsonl` 记录当前协议输出。比较既不将当前事件反向投影为历史格式，也不剥除结构差异。独立迁移测试验证正式转换，而不把原生 writer 布局当作其预期事件序列。

### 录制、回放与刷新

`pnpm run test:snapshot:record` 调用在线 LLM（大语言模型），并在规范具名版本文件下写入收集到的当前 generation。record 与 refresh 绝不重命名或删除已完成的 generation，即使后续运行不再产生某个 child 角色也一样；受审阅的源树整理只有在同角色存在已验证的当前替代文件后才移除前代。显式声明 `sessionFormat` 的场景在录制模式下保持只读。`pnpm run test:snapshot:refresh` 保持无密钥，运行选定的最高 replay 输入，并写入 stdout、各 pin 自有的提示词与工具 schema 伴随文件，以及新鲜当前 generation 的可比较 Session 输出；保留历史输入的场景写入单独的 writer 输出比较基准，而非规范当前格式 replay 代际。每个组合 owner 把 replay patch 放在 live patch 旁；顶层 `snapshots/` 拥有 Session 驱动场景，其他预期输出留在其 package owner 旁。[`dsh-llm-replay`](../llm-replay/README.zh.md) 提供通过 `DSH_SNAPSHOT_*` 环境值选择的已记录流。

### 固定请求 header 与系统提示

每个 pin 默认拥有其生成的 `system-prompt.expected.md` 或 `tool-schemas.expected.json` 伴随文件；当完整的对应序列相同时，`systemPromptSource` 与 `toolSchemasSource` 指定另一个 pin 作为来源，因此每个不同版本只提交一次。系统提示是 surface 节点 0，作为 `system/message` 事件记录在该步骤第一个 `request/header` 之前；每个 fixture 把其文本块存储为 `"text":"{{system}}"`，提示词伴随文件保留完整文本。该 pin 的 `request/header` 事件存储 `"tools":"{{tools}}"`，同时保留配置与原因，结构化 schema 伴随文件保留完整目录。自身作用域组合出不同请求的 child Session 按 fixture 索引以 `pinsChildToolSchemas` 与 `pinsChildSystemPrompts` 单独声明。运行中改变请求 header 的场景声明 `expectedHeaderChanges`；运行中提示词发生变化的场景——替换节点 0，或在 `in-history` 路由上追加到已缓存历史之后——声明 `expectedPromptChanges`，每次变化在提示词伴随文件中增加一个 `<!-- system/message change N -->` 小节。manifest 中对应字段为 `header.changes` 与 `header.promptChanges`。

### 平台与组合变体

需要非 Windows 主机的场景声明 `posixOnly`，在 Windows 上跳过运行测试，但 fixture 保护仍在所有平台覆盖其已提交文件；组合需要可用 `pwsh` 的场景声明 `pwshOnly`。当临时目录授权自身待测时，`workspaceParent` 将生成子级 cwd 移出平台临时区域；场景签入的 `workspace/` 会先复制到该子级，随后 `prepareWorkspace` 在 agent 启动前针对生成 cwd 运行。默认生成的 workspace 在会话 fixture 中存储为 `{{cwd}}`，使平台临时根目录与随机 basename 不影响录制。headless manifest 在测试 Session workspace 授权本身时使用 `workspace.parent: outside-temp`。适配器在父目录可写且位于系统临时授权之外时，于平台临时根目录旁分配目录，否则使用 home，并拒绝已被自动临时写授权覆盖的生成 cwd。

### 可能出什么问题

- **子会话轮次等待失败**——即使首次日志收集就超过期限，`waitForSubagentTurnEnd` 也会指出子会话、目标轮次与等待期限，并通过错误的 cause 保留底层失败。
- **fixture 保护拒绝已提交文件**——遗留场景目录、缺失文件、一个 header 类别包含多个 pin、重复的伴随文件内容、未擦除的提示文本或工具 schema、没有前置 `system/message` 的 `request/header`，以及格式错误的 pin header 都会在比较运行前使套件失败。
- **会话收集需要原始 JSONL mode**——快照配置使用 JSONL 后端的 `compression: 'none'`；压缩 JSONL 没有快照收集路径。
- **构建 mode 需要当前产物**——选择 `DSH_EXAMPLE_MODE=lib` 前先运行 `pnpm run build`；源 mode 仍是零构建路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具包的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

共享核心拥有 manifest、generation 限定角色选择、workspace 设置／比较、类型化身份映射、normalizer 与 fixture 不变式。ACP 适配器增加四个可组合层：launcher、场景 harness、normalizer 与 suite factory。`launchAcpTestAgent` 在 tsx 下启动源码 profile，或在普通 Node 下启动已构建 `lib` profile，通过原始字节 stdout tee 连接 SDK client，收集 Session update 与 stderr，默认拒绝未处理的权限请求，并负责关闭。`runScenario` 驱动 ACP JSON-RPC stdio，并收集每个 Session 目录中数值最高的持久原始 JSONL generation。纯 normalizer 把 cwd 路径与类型化身份变为稳定 token，将时间归零、展开物理来源区间，并擦除系统提示词文本与工具 schema bulk。`defineAcpSnapshotSuite` 注册比较、generation 限定 fixture 回写与实时一致性保护。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/launcher.ts`](src/launcher.ts) | 子进程/客户端启动器与关闭所有权 |
| [`src/harness.ts`](src/harness.ts) | 脚本化场景驱动与会话日志收集 |
| [`src/manifest.ts`](src/manifest.ts) | 封闭 `snapshot.yml` schema、收集与归属规则 |
| [`src/session-files.ts`](src/session-files.ts) | 规范 parent/child generation grammar、header 一致性与最高角色选择 |
| [`src/identity.ts`](src/identity.ts) | 跨父子日志的类型化首次出现身份 token 化 |
| [`src/normalize.ts`](src/normalize.ts) | 纯规范化器与擦除辅助 |
| [`src/workspace.ts`](src/workspace.ts) | 场景 workspace 设置与完整预期状态比较 |
| [`src/suite.ts`](src/suite.ts) | 场景表套件工厂、fixture 保护、录制/刷新回写 |
| [`src/index.ts`](src/index.ts) | 再导出四个层的包入口 |
| — | 不发布运行时不变式伴生入口；该测试支持包不拥有任何生产事件流或可变数据；消费它的测试套件会检验该工具包。 |

### 数据流

场景在启动器下运行 agent，通过 harness 向它喂入输入脚本，并捕获 stdout 与持久化日志。规范化器把捕获内容规范化——id 转为首次出现序列、生成 cwd 转为 `{{cwd}}`、`system/message` 文本转为 `{{system}}`、header 工具 schema 转为 `{{tools}}`——使已录制与本次运行可以结构化比较。随后工厂把规范化 stdout 与重新持久化日志同已提交 fixture 比较，或在录制/刷新模式下回写它们；其保护在任何比较结果被采信之前就拒绝畸形或漂移的 fixture。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从快照工具包逐步进入模型 fixture 来源、启动机制与要求该层级存在的策略。

- [llm-replay](../llm-replay/README.zh.md)——回放模式消费的无密钥模型 fixture 来源。
- [loader-smoke](../loader-smoke/README.zh.md)——启动器所依赖的模式感知子进程启动机制。
- [测试策略](../../../docs/testing.zh.md)——无密钥快照层、其适用时机与 fixture 归属规则。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无。该测试专用支持会记录、规范化并比较 profile 会话，不会改变 agent 组装的模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明何时需要对该工具包特别小心。它们是当前包约束，不是任务积压。

- **会话收集需要原始 JSONL mode**——`runScenario` 收集持久化 `.jsonl` 日志，因此快照配置使用 JSONL 后端的 `compression: 'none'`；压缩 JSONL 没有快照收集路径。
- **构建 mode 需要当前产物**——选择 `DSH_EXAMPLE_MODE=lib` 前先运行 `pnpm run build`；源 mode 仍是零构建路径。
- **ACP 继续覆盖协议行为**——刺激来自 ACP 客户端的取消与权限往返留在该适配器；组装式一次性行为与持久控制行为使用 headless 与 SDK 适配器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
