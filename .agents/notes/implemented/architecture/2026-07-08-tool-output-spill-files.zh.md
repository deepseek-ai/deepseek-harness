# Agent Note: 工具输出 spill 策略

Status: implemented

[English](2026-07-08-tool-output-spill-files.md) | 中文

## 问题

工具输出需要有界的模型可见预览，但部分超大结果仍可能在之后有用。抓取的页面正文或冗长的工具响应不应完整占用下一次模型请求，但模型应能使用现有文件读取工具，在之后查看经过格式化的完整结果。

这项改动之前的行为并不一致。`dsh-bash-local` 已经会在内存尾部溢出时，把完整 stdout／stderr 流写入私有的临时 spill 文件；普通文本工具结果则仍以内联形式返回，除非工具自行实现上限。[工具结果保留库](../../archived/architecture/2026-07-06-tool-result-retention-library.md)负责预览机制，但不负责存储，也不负责把这些机制应用于最终工具结果的执行流水线策略。

其形态与超时策略设计一致：工具作者声明规范值与 Native renderer（原生渲染器），由策略插件在渲染后的内容上执行部署默认的上下文预算。工具仍可在提供方采集上限处提前 spill；由工具负责的展示 spill 可以保留已完整采集的规范值，而只替换展示内容。[规范工具输出约定](2026-07-20-canonical-tool-output-contract.zh.md)规定了这项区分。

## 决策

在新的 `packages/spill/` 分组下增加一层轻量 spill 存储 seam 和一个默认 spill 策略插件：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-spill` | 接口：`ctx.spillStore`、词汇类型，不包含存储实现。 |
| `@deepseek-ai/dsh-spill-local` | 本地后端：在宿主文件系统中提供私有、会话作用域的文件存储。 |
| `@deepseek-ai/dsh-spill-policy` | 工具结果策略插件：包装分发后的最终文本结果，并以保留预览和 spill 定位符替换超大结果。 |

工具结果消费方是 `dsh-spill-policy`，它通过 `tools/post-execute` waterfall（瀑布式事件）使用最终工具结果。模型按照后端随定位符返回的检索提示读取内容。[会话引用 spill 复用](../bug-fix/2026-09-05-session-reference-spill-reuse.zh.md)增加一个直接存储消费方，采用独立的预览、来源信息与失败语义；它不改变工具结果策略。

### spill seam

存储 seam 保持最小化：保存文本，并返回定位符与检索提示。

```ts ignore-check
interface SpillStore {
  saveText(input: SaveTextSpill): Promise<SpillRef>
}

type SpillSource = {
  kind: 'tool'
  toolName: string
  callId: ToolCallId
  label: string
} | {
  kind: 'session-reference'
  sessionId: SessionId
  label: string
}

interface SaveTextSpill {
  owner: { sessionId: SessionId }
  source: SpillSource
  suggestedName: string
  content: string
}

type SpillLocator = Branded<'SpillLocator'>

interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` 是一个[品牌化的](../../../../packages/util/brand)模型可见句柄，由后端返回。本地后端将其渲染为文件系统路径；远程或数据库后端可以渲染 URI、键或命令 token。消费方把它视为不透明值，并使用 `retrievalHint` 渲染，而不是假定 `read` 始终是正确的检索机制。`SpillOwner.sessionId` 是保存时的存储命名空间：fork 后的会话会从种子日志继承已有的 spill 定位符，无需复制它们或重新取得所有权；fork 后的新 spill 使用子会话 id。保留期清理可以连同其他旧会话产物一起使旧定位符失效；spill seam 不定义逐会话的清理策略。

`dsh-spill-local` 负责存储细节：选择会话作用域的目录、安全名称、防止路径遍历、执行写入、本地产物生命周期，以及返回 `{ locator, bytes, retrievalHint }`。它不负责工具结果替换、模型可见的预览策略、搜索、文件检查，也不定义 seam 级或逐会话保留策略。文件写入 `<root>/session-<hash>/<random>-<safeName>`：`root` 是配置路径，或延迟创建的私有（0700）进程级临时目录；会话子目录是 `sha256(sessionId)` 的短前缀；叶节点由随机十六进制前缀与调用方的 `suggestedName` 组成，后者会被清理成单一路径段（与 JSONL 后端的 `encodeSegment` 一致）。系统使用 `open(path, 'wx', 0o600)` 写入，确保独占且仅所有者可访问，因此预先植入的符号链接无法重定向写入。定位符就是该路径，检索提示则告知模型可以在该路径上使用 `read` 或 `grep`。它的一次性启动清理会应用[本地 spill 清理说明](../../archived/architecture/2026-07-17-local-spill-startup-cleanup.md)所述的后端专属产物生命周期。

### spill 策略

`dsh-spill-policy` 是一个 `tools/post-execute` 结果转换器，只提供一个配置项：

```ts ignore-check
interface Config {
  /** Omitted means no automatic spill policy. Present means apply to oversized plain text tool results. */
  maxInlineBytes?: number
}
```

省略 `maxInlineBytes` 时，插件不会注册任何内容，是真正的无操作。设置该值后，它会对最终的纯文本工具结果应用默认策略：

1. 让工具正常运行，通过 `next()` 委托，使下游监听器先结算结果。
2. 仅当已接受的最终 `ContentBlock[]` 全部是纯文本时，才将其展平；含任何非文本块的结果保持不变。
3. 如果 UTF-8 字节大小不超过 `maxInlineBytes`，保持不变。
4. 如果超出上限，使用完整的最终文本调用 `ctx.spillStore.saveText()`。
5. 把模型可见结果替换为保留的首尾预览和 spill 引用。

预览属于策略所有的实现默认值：以 `maxInlineBytes` 为上限，使用保留库的 `TextRetainer` 进行首尾分割。只有第二个部署证明有此需求后，未来配置才会公开预览大小。

替换文本刻意保持通用，因为策略只知道最终格式化的工具结果，不了解工具的内部资源：

```text
<retained preview>

(Omitted N bytes. Full formatted result stored at: /.../session-.../....txt. Use read with offset/limit, or grep this path to search within it.)
```

如果 `ctx.spillStore.saveText()` 失败（权限、ENOSPC、后端不可用），或调用没有会话所有者，或未加载后端，插件会记录原因并原样返回结果。spill 失败绝不会把成功的工具调用变为 `isError` 结果，也不会隐藏内联结果。

策略跳过 `read`，以避免形成 `read -> spill file -> read again` 循环。额外的选择退出配置要等确实出现第二个有此需求的工具后再引入。

## 示例：web_fetch

`web_fetch` 是首个示例，因为它天然会返回较大的文本结果，而且无需工具专用的 spill 代码。该工具本身无需特殊处理：

```ts ignore-check
ctx.tools.register(defineTool({
  name: 'web_fetch',
  output: {
    schema: WEB_FETCH_RESULT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: formatFetchOutput(value) }],
  },
  async execute(args, exec) {
    const result = await ctx.web.fetch({ url: args.url }, exec.signal ? { signal: exec.signal } : undefined)
    return result
  },
}))
```

配置 `dsh-spill-policy` 后，格式化后的大型 fetch 结果会自动保留并 spill。部署通过把提供方资源上限设得高于策略上限来展示此行为：

```yaml
- id: web-fetch-http
  name: '@deepseek-ai/dsh-web-fetch-http'
  config:
    maxBodyChars: 500000

- id: spill-local
  name: '@deepseek-ai/dsh-spill-local'

- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

这项分离很重要。`web-fetch-http` 仍负责资源上限（`maxResponseBytes`、`maxBodyChars`），用来保护网络、内存和解码工作。`spill-policy` 只负责结果已经存在后针对模型上下文的上限。如果提供方已经返回 `truncated: true`，spill 文件包含的是工具返回的完整格式化结果，而不是原始网页全文；策略不会做出其他承诺。

## 与保留和提前 spill 的关系

保留与 spill 存储相互独立：

- `@deepseek-ai/dsh-output-retention` 负责预览机制（`TextRetainer`、`ItemRetainer` 和省略元数据）。
- `@deepseek-ai/dsh-spill` 负责保存最终文本，并返回定位符与检索提示。
- `@deepseek-ai/dsh-spill-policy` 在工具流水线中应用默认的最终结果策略，将前两者组合起来。

最终结果策略不能取代由工具负责的提前 spill。部分有用内容并不存在于最终 `ToolExecutionResult.content` 中：

- `bash` 的最终输出已经是尾部内容加临时 spill 路径；完整的 stdout／stderr 流位于执行器文件中。
- `subagent` 的最终输出是 subagent 的最终回答，而不是 subagent 的执行轨迹。
- 未来的工具可能生成从未出现在最终 `ToolExecutionResult.content` 中的运行时产物。

这些场景可以在后续工作中直接使用 `ctx.spillStore`，不属于首个示例的范围。

## 非目标

- 本决策不增加面向模型的 `artifact_read` 或 `artifact_search` 工具。
- 本决策不增加逐工具的保留配置。
- 不增加面向模型的超时／截断参数。
- 不把 `read` 输出迁移到 spill 文件。
- 不取代 `web-fetch-http.maxBodyChars` 等提供方／资源上限。
- 第一版不统一 bash 临时文件，也不采集 subagent 执行轨迹。

## 延后事项

- 用于现有执行器 spill 文件的 `saveFile()`／`linkOrCopy`，这是统一 bash 行为所必需的。
- 由工具负责的 subagent 执行轨迹 spill（`await run.result`，在 `run.dispose()` 前读取进程内子会话，保存 JSONL）。
- 如果内置的 `read` 跳过规则不足，再增加逐工具选择退出或逐工具策略声明。
- 面向 ACP（Agent Client Protocol）或远程环境的远程／数据库存储后端，因为本地路径在这些环境中没有意义。

本地后端通过一次性启动扫描清理旧文件，而不是绑定到会话删除——参见[启动清理 Agent Note](../../archived/architecture/2026-07-17-local-spill-startup-cleanup.md)。seam 仍未定义逐会话清理策略；保留策略属于后端。

## 测试

- `dsh-spill` 单元测试锁定 seam 约定：注册为 `ctx.spillStore`、每个上下文只允许一种实现，并在 dispose（资源释放）时释放。
- `dsh-spill-local` 单元测试覆盖 `saveText`、`encodeSegment` 清理（分隔符／波浪号／完整路径段的点／空值）、会话哈希目录、仅所有者权限、每次保存生成不同路径、配置根目录／私有根目录，以及存储失败时的拒绝。
- `dsh-spill-policy` 单元测试通过 `ctx.tools.execute` 驱动真实工具：禁用模式下无操作、替换超大文本、小结果／非文本结果保持不变、跳过 `read`、尽力回退（保存失败／无后端／无所有者），以及下游组合（限制已替换结果、保留 `additionalContexts`）。
- `dsh-tool-web` 集成测试驱动 `web_fetch`，其实际执行路径经过 `ctx.tools.execute`，并使用真实的 `spill-local` 后端与策略；测试证明只有刻意加入的 spill 提示会改变模型可见文本，而 spill 文件保存完整的格式化结果。
- `tui-agent` 示例加载 `spill-local` 与 `spill-policy`，因此其无密钥 Loader／PTY 冒烟测试会执行真实加载路径（namespace-plugin 导出形态与 `inject`）。

## 影响

默认策略只能看见最终格式化文本。它无法保留已经由提供方限制的内部内容，也无法保留从未成为结果一部分的运行时产物。第一版聚焦最终结果 spill 而不是提前 spill，因此可以接受这一限制；由工具负责的提前 spill 仍属于后续工作。

本地后端返回真实路径，使其保持简单并符合已经验证的 agent（智能体）工具行为；seam 本身只承诺一个不透明定位符加检索提示，所以远程后端可以返回非文件定位符。

本地后端的价值取决于现有 `read`／`grep` 工具能否检查返回的本地路径，即使 spill 目录位于会话 cwd 之外。这一条件成立，因为文件系统策略会记录观察结果并设置写保护，但不会把读取限制在工作区内。未来的工作区限制策略必须显式允许本地 spill 路径，或改用检索提示指向受支持读取器的非文件 spill 后端。

**快照缺口。** 目前没有 ACP 快照场景覆盖 transcript（文本记录）可见的 `web_fetch` spill 提示。ACP 快照 harness 在无密钥环境中回放，无法访问实时 web，而 `web_fetch` spill 需要一个真实的超上限 HTTP 正文；确定性场景需要一个预置的 loopback fetch 目标，但当前回放树尚未接线（示例根本没有加载 `tool-web`）。该行为改由 `dsh-tool-web` 针对 loopback server 的集成测试覆盖。弥补该缺口属于后续工作：把 `tool-web` 和预置 fetch 目标接入 ACP 示例，然后录制 `web-fetch-spill` 场景。

如果策略开始负责工具专用语义，就会膨胀得过大。它的范围保持狭窄：只处理纯文本最终结果。由工具负责的提前 spill 仍留作未来工作。

## 考虑过的替代方案

**要求每个工具通过保留声明选择加入。**不予采纳，因为目标是实现类似 Claude Code 通用工具结果持久化的默认行为。只需一个 `maxInlineBytes` 部署配置项即可验证该形态。

**把 `tool-results` 建成宽泛的工具结果平台。** 不予采纳：宽泛的包名会诱使系统把保留策略、结果替换、预览措辞、搜索和提前 spill 合并进一个 seam。可共享的存储部分更小：保存文本，并返回定位符与检索提示。

**使用 `ctx.fs.writeText` 或面向模型的 `write` 工具。** 不予采纳：工作区文件系统写入带有项目文件语义、写入／编辑策略、观察状态和面向用户的副作用。spill 文件是运行时产物，不是由模型编写的工作区改动。现有 `read` 工具之后可以检查它们，但创建操作属于运行时 spill seam。

**让 `web-fetch-http` 不受限地抓取，只依靠 spill-policy。** 不予采纳：spill-policy 在最终工具结果已经存在之后才运行，无法保护网络、内存或解码资源。提供方资源上限仍然必须存在。

**把保留合并进 spill 机制。** 不予采纳：保留与 spill 职责不同。`TextRetainer`／`ItemRetainer` 决定保留哪部分预览、又省略了什么；spill 存储只负责保存策略要求的最终文本。
