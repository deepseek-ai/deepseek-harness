# Agent Note: LSP 能力 seam 与面向模型的查询工具

Status: implemented
Archived: 2026-09-04

[English](2026-07-15-lsp-capability-seam.md) | 中文

## 问题

harness 已具备文本搜索与文件读取能力，但二者都无法识别程序符号。文本匹配无法可靠地区分同名函数、跟踪导入别名、关联接口与具体实现，也无法报告推断类型。因此，agent（智能体）在修改代码前缺少人类通过编辑器语言服务器获得的语义导航能力。

语言服务器协议（Language Server Protocol，LSP）支持分属三个职责方：模型需要稳定的查询 schema，harness 需要提供方选择与规范化结果，本地实现则负责进程、JSON-RPC、工作区、同步与文件系统行为。将三者合并会使模型约定绑定本地子进程，并阻碍远程或沙箱原生提供方。

许多语言服务器在查询文档已按当前文本打开时表现最佳。兼容的 agent 客户端必须限制这项状态、定义内部读取是否算作模型观察，并确保文档快照与服务器工作区索引位于同一文件系统命名空间。

## 决策

将 LSP 建成由三个包组成的能力 seam，其中包含一个只读模型工具和一个通用本地提供方实现：

1. `packages/lsp/lsp` 下的 `@deepseek-ai/dsh-lsp` 负责 `ctx.lsp`、提供方注册与选择、标准化请求与结果、执行控制，以及结构化 LSP 错误。
2. `packages/lsp/lsp-stdio` 下的 `@deepseek-ai/dsh-lsp-stdio` 将配置的 stdio 语言服务器适配到该 seam。一个插件实例接收具名服务器表，并为每组命令及扩展名到语言 id 的映射注册一个隔离的提供方。
3. `packages/lsp/tool-lsp` 下的 `@deepseek-ai/dsh-tool-lsp` 负责面向模型的 `lsp` schema、提示词指导、参数校验、结果限制与格式化，以及与传输方式无关的 UI 展示。

`dsh-lsp-stdio` 是通用 host，不是语言服务器目录或安装器。部署显式配置命令与映射；未来 preset 属于组合插件或 `cordis.yml` overlay。

模型与 seam 仅公开 `goToDefinition`、`findReferences`、`goToImplementation` 和 `hover`；`ctx.lsp` 不提供任意 JSON-RPC 方法。这些操作字面量与 Claude Code 熟悉的 camelCase 命名一致，而工具名与 `file_path` 字段仍由 harness 自行定义。

提示词将 LSP 定位为精确查询手段：`Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references.`

## 包与职责边界

`dsh-lsp` 按带品牌类型的 id 和扩展名到语言 id 的映射注册提供方。`registerProvider()` 以原子方式占用 id 与所有规范化扩展名：输入无效或存在冲突时不发布任何状态，dispose（资源释放）函数释放全部占用。提供方插件通过 `ctx.effect()` 注册。系统按查询且不受顺序影响地选择提供方；没有匹配项时返回结构化不可用错误。第一版不提供 glob、language-id 或显式路由选择器，也不静态声明操作能力。

seam 只公开 `query(request, signal?)`，因为没有字段需要实现层填充默认值：`workspaceRoot` 是必填项，`languageId` 来自注册映射，超时与结果限制由消费方负责。`query()` 执行选择与推导时不使用隐藏的 `??` 后备逻辑，因此没有需要 resolve 的可执行 spec。`dsh-tool-lsp` 校验模型参数，并只把 `exec.signal` 作为裸 `AbortSignal` 传递，与 web 一致，并使 `dsh-lsp` 不依赖 `dsh-tools`。提供方在选择前被移除时按不可用失败；之后的 dispose 遵循已选提供方的取消生命周期，不改路由。

约定如下：

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
type LspProviderId = Branded<'LspProviderId'>

interface LspPosition {
  readonly line: number
  readonly character: number
}

interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

interface LspQueryRequest {
  readonly operation: LspOperation
  readonly filePath: string
  readonly position: LspPosition
  readonly workspaceRoot: string
}

interface LspProviderQuery extends LspQueryRequest {
  readonly languageId: string
}

type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly { readonly uri: string; readonly range: LspRange }[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: { readonly contents: string; readonly range?: LspRange } | null }

interface LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}

interface LspService {
  registerProvider(provider: LspProvider): () => void
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}
```

映射键规范化为带前导点的小写扩展名，并按 `filePath` 的最后一个扩展名选择；语言 id 仅用于文档同步。seam 中的位置和范围从零开始按 UTF-16 计数。`findReferences` 始终包含声明：提供方在内部执行该约束，本地映射设置 `context.includeDeclaration: true`，调用方不能配置。封闭结果联合将导航统一为位置，将 `hover` 统一为内容或 `null`；导航结果携带提供方的规范工作区 URI，使消费方在执行世界的命名空间内相对化文件 URI。seam 不公开协议类型、进程或文档控制，也不提供通用请求逃生口。

`dsh-lsp-stdio` 负责服务器配置、JSON-RPC、进程与临时文档状态和协议转换。它通过 `ctx.fs` 读取，通过 `ctx.subprocess` 启动，只依赖二者的 Service Definition 包而非具体提供方；[可移植执行环境决策](2026-07-28-portable-execution-world-consumers.zh.md)负责定义这种配对。服务器表的键是提供方 id。插件在注册前解析每个服务器的本地设置；如果后续映射无效或发生冲突，插件会撤销此前的注册，并为每个提供方保留独立进程池。`dsh-tool-lsp` 在运行时只注入 `tools`、`lsp` 和 `systemPrompt`，通过包内的 `sessionCwd(exec)` 辅助函数从 `exec.agent?.session.header.cwd` 取得工作区，其取值方式与文件系统工具一致，也不导入提供方。

## 面向模型的约定

单一 `lsp` 工具接受以下参数：

```ts
interface LspToolInput {
  readonly operation: 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
  readonly file_path: string
  readonly line: number
  readonly character: number
}
```

`line` 和 `character` 是从 1 开始计数的正数 UTF-16 光标坐标；工具将其转换为 seam 中从零开始的 `LspPosition`，并将渲染位置转回。`findReferences` 包含声明，避免影响分析漏掉定义位置。提供方、语言 id、工作区根目录、限制、超时、初始化和可执行文件均不进入模型输入。

工具必须从会话 `header.cwd` 取得 `workspaceRoot`，没有后备值；缺失时在查询或启动前以 `LSP_WORKSPACE_REQUIRED` 失败。本地提供方基于根目录解析相对路径并直接接受绝对路径；两种路径都会进行规范化，如果目标位于规范工作区外，则在启动前拒绝。

位置在不应用 harness 宿主路径规则的情况下按文件稳定分组并渲染为 `path:line:character`。有效的 `file:` URI 落在提供方的规范工作区 URI 内时转换为相对路径，位于其外时转换为从 URI 派生的绝对路径；格式错误的 URI 与非 `file:` URI 保持原样。`maxLocations` 默认值为 `100`，并报告省略的条目；`maxResultChars` 默认值为 `16_000`，并限制每个完整渲染结果，其中包括截断元数据。空位置与 `null` hover 是成功的无结果响应；服务器载荷缺失或格式错误时，以结构化 `LSP_MALFORMED_RESPONSE` 错误失败。

与传输方式无关的展示器使用 `{ card: 'generic', kind: 'search', title, locations: [{ path: file_path, line }] }`，`title` 由参数推导并标明操作与光标。由于 `FileLocation` 没有 character，跟随位置聚焦输入行，标题保留完整光标；展示保持纯函数。

## 超时归属

`dsh-tool-lsp` 将一个可配置的 `timeoutMs` 预算附加到工具定义，默认值为 `60_000`。`dsh-tool-call-timeout-policy` 执行预算并提供传入 `ctx.lsp.query` 的 `exec.signal`；该预算覆盖排队、打开、查询和关闭的完整生命周期，模型不可配置。

seam 和提供方不增加启动或请求截止时间。非工具调用方不会获得隐藏超时，必须自行提供 `AbortSignal`，并在需要预算时使用 `deadline()`。

提供方 dispose 发生在工具执行之外，因此 `dsh-lsp-stdio` 保留 `shutdownTimeoutMs`（默认 `5_000`）限制 `shutdown`/`exit`，以及 `killGraceMs`（默认 `2_000`），同时用于限制请求取消宽限期和从 SIGTERM 升级到 SIGKILL 的宽限期；失败实例的清理也使用相同边界。定时器值超过 Node `2_147_483_647` ms 的调度范围时，插件加载失败。提供方使用 `deadline()` 和 `timeoutOf()`，但仍负责请求取消、进程信号和等待关闭，因为超时通知不会终止工作。

## 工作区、文件系统与文档同步

`dsh-lsp-stdio` 在语言服务器的执行环境中通过 `ctx.fs` 规范化并读取文件。它要求工作区目标是目录，使用提供方自有的 containment 拒绝工作区外的源文件，消费 `streamText`，并在分片到达时执行 `maxDocumentBytes` 上限；普通文件校验和 UTF-8 解码仍由提供方负责，文档上限则由协议消费方负责。它会针对每项文件系统操作合并调用方取消与提供方 dispose，跟踪尚未进入队列的工作区查找，并在 dispose 期间等待这些查找结算。它不发送 `fs/observed`：只有 LSP 结果对模型可见，因此查询不满足写前读取策略。

`read` 工具的输出带窗口与行号，进入 transcript（文本记录）且已被观察，不适合作为源文件。在 `tool-lsp` 内读取还会把提供方专用同步职责交给消费方，并排除非本地提供方。

本地提供方对每次查询都采用兼容优先的临时打开流程。它接受旧式 `textDocumentSync` 的 `Full` 或 `Incremental`，也接受设置了 `openClose: true` 的选项；同步能力缺失、为 `None` 或明确不兼容时，在 `didOpen` 前以不支持错误失败。

1. 通过 `ctx.fs` 解析源文件并检查其位于工作区内，再通过同一提供方流式读取当前文本，同时执行文档字节上限。
2. 发送 `textDocument/didOpen`，其中包含版本 `1`、完整文本和配置的语言 id。该写入仍可取消；写入失败或遭取消会使实例失效，并等待有界进程终止完成，池才能复用它。
3. 发送所请求的 `textDocument/definition`、`textDocument/references`、`textDocument/implementation` 或 `textDocument/hover` 请求。
4. 如果 `didOpen` 成功，则在请求完成或取消后于 `finally` 中尝试发送 `textDocument/didClose`。关闭写入失败不会覆盖已经确定的结果或错误，但会使实例失效，并等待有界进程终止完成。

每次调用后都关闭文档，因此第一版不需要 `didChange`、`didSave`、内容缓存、变更监听器或文档 LRU。每个工作区的提供方队列可取消，并串行执行源文件读取、打开、查询和关闭的完整生命周期，因此等待中的查询只在轮到它时才读取当前字节；实例也会串行执行协议生命周期。不同工作区可以并行。服务器工作区索引仍负责从源文件跳转到的已关闭文件。

规范工作区目标必须是目录。其目标键提供进程池 identity，进程路径提供 cwd，归提供方所有的 `file:` URI 则提供 `rootUri` 和唯一的 `workspaceFolders` 条目；文件系统提供方将别名解析为同一键时，它们共享实例。结果位置可以在工作区外，但外部路径不能成为查询源。无法与挂载的子进程提供方共享路径的文件系统属于组合错误，不是另建 LSP 包的理由。

## 本地服务器生命周期与协议行为

`dsh-lsp-stdio` 按 `(provider id, canonical workspace target)` 懒启动一个服务器，并通过 single-flight 合并启动。插件加载时，它使用已配置的环境调用 `ctx.subprocess.resolveExecutable()`；命令不可用时在注册前失败。首次查询通过原始协议管道启动服务器，不经过 shell，并收集有界的 stderr 尾部。`maxMessageBytes` 默认值为 `16_000_000`，`maxStderrBytes` 默认值为 `1_000_000`，`maxDocumentBytes` 默认值为 `4_000_000`。崩溃使当前查询失败且不重放；后续查询可以替换进程。每次查询最多启动一个进程，因此 MVP 不设置跨请求重启计数器。

初始化使用 `processId: null`，因为客户端与服务器可能位于不同的进程命名空间。它声明 `general.positionEncodings: ['utf-16']`、`workspace: { workspaceFolders: true, configuration: true }`、`textDocument.hover.contentFormat: ['markdown', 'plaintext']`，以及 definition 与 implementation 的 `linkSupport: true`，但不支持动态注册。服务器返回的操作与同步能力均为真源。服务器省略 `positionEncoding` 时默认为 `utf-16`；其他值均属于协议错误。配置可以提供初始化选项和 `workspace/configuration` 响应，但客户端拒绝 `workspace/applyEdit`，绝不执行命令或编辑。

导航结果直接映射 `Location`，并将 `LocationLink` 的 `targetUri` 与 `targetSelectionRange` 映射为统一位置。位置必须是非负整数。`hover` 归一化只接受有效的 `MarkupContent` 和 `MarkedString` 结构，保留字符串值，把带语言标签的值渲染为围栏代码块，并以一个空行连接数组。面向模型的工具在渲染后应用 `maxResultChars`。

取消信号传递到查询的所有阶段，请求 id 创建后还会发送 `$/cancelRequest`。无响应的服务器会被终止并等待关闭；实例串行化保证没有其他正在执行的工作被连带中断。dispose 会拒绝并取消工作、尝试优雅关闭、通过有界终止流程升级处理，并等待完全停稳。

## 明确延后的 API

符号操作因需要不同 schema 且与读取或搜索重叠而延后；未来的工作区符号工具必须接收搜索词。调用层级因支持度不一而延后，`prepareCallHierarchy` 仍是内部准备步骤，不是模型操作。

诊断需要独立的新鲜度、累积与 transcript 规则。重命名、代码操作和格式化等变更能力需要单独工具，并集成预览、权限和写入策略。

提供方信任配置的服务器。其文件系统可见性与进程隔离完全取决于挂载的执行环境；LSP 不增加独立的沙箱策略。

## 备选方案

**照搬 Claude Code 的统一 schema。** 它的光标操作验证了核心场景，但符号与调用层级需要不同参数。照搬九种操作会固化尚未验证的接口，因此该 seam 只对齐四种语义查询。

**允许提供方注册工具。** 已加载服务器会控制模型 schema 和提示词，无法在本地与远程提供方之间维持统一约定。

**公开任意 LSP 方法。** JSON-RPC 逃生口会泄露协议载荷，并允许未经评审的变更或命令执行；操作联合保持封闭。

**公开 `resolve(request)` / `query(spec)`。** 没有需要填充默认值的字段时，resolve 只会暴露提供方选择，而公开 spec 可能持续到提供方 dispose 或替换之后。单一操作让选择与调用共用注册生命周期。

**将信号包装为 LSP 执行上下文对象。** Web 传递裸 `AbortSignal`；仅包装这一个字段会造成无谓的不对称。只有另一个字段确有需要时，`query()` 才引入上下文对象。

**通过面向模型的 `read` 工具读取。**拒绝，因为工具输出带窗口与行号，会进入 transcript 且已被观察。提供方直接通过子进程所用的同一 `ctx.fs` 执行环境消费流式传输的完整文本。

**保持文档打开。** 镜像编辑需要版本归属、覆盖所有路径的 `didChange`、HMR 恢复、淘汰和陈旧状态规则。临时打开避免在 MVP 引入这套状态机。

**配置分阶段超时。** 嵌套定时器会产生相互竞争的分类与新预算。一个由调用方负责的截止时间覆盖查询；只有调用外清理保留本地限制。

**不发送 `didOpen`。** 协议虽允许，但支持不一致且可能使用陈旧服务器状态。临时打开提供明确的当前快照。

**增加路由或选择首个匹配项。** 注册顺序与 HMR 时机不是产品语义，路由表又会重复唯一扩展名所有权。因此，扩展名重叠时注册失败。

**在一个实例中并发查询。** 取消失败时，终止共享进程会杀死无关工作。实例内串行可限制影响范围；不同实例仍可并行。

**内置 preset 或 PATH 发现。** 目录会让通用 host 承担语言策略，而发现机制无法推断参数、语言 id 或初始化配置。部署显式配置提供方，组合插件可以封装 preset。

## 测试

- 包测试固定三个包的依赖方向、运行时注入和仅通过 `ctx.lsp` 通信的边界。
- 工具测试固定四种操作、坐标校验、配置限制与省略标记、提示词和 UI 展示。
- 注册表测试固定原子占用/释放、不受顺序影响的选择，以及结构化的不可用、已释放、冲突和不支持操作错误。
- 测试用 stdio server 固定精确的初始化能力、四种协议映射、`Location`/`LocationLink` 与 `hover` 归一化，以及 `findReferences` 到 `references.includeDeclaration` 的映射。
- 同步测试固定 UTF-16 协商与转换、受支持和被拒绝的 `textDocumentSync` 形式、打开写入阻塞与失败、配对的临时打开/关闭、关闭写入失败和错误响应拒绝。
- 超时测试固定一个 `TOOL_TIMEOUT` 预算、不对上游取消错误分类、LSP 无隐藏截止时间，以及受限且等待完成的清理。
- 生命周期测试固定启动 single-flight、完整生命周期串行化及排队查询读取最新源文件、跨工作区并行、可取消队列、崩溃后不重放的替换、stdin 失败后的进程拆除，以及 dispose 后完全停稳。
- 文件系统宿主测试固定 session cwd 要求、提供方自有的 containment 与 URI 渲染、有界文档读取、无格式源文本和不发送 `fs/observed`。
- 无密钥且固定版本的 TypeScript 真实服务器 e2e 覆盖四种操作；可运行配置使用同一项显式提供方映射。
- 快照覆盖模型可见 schema、提示词、结果和省略提示；构建产物冒烟测试覆盖分帧与清理。
- 包与架构文档覆盖配置、安全边界和搜索/读取指导；同一改动中，新的 `packages/lsp/` 包组要加入 AGENTS.md 的仓库布局块、packages/README.md 的分组表和 architecture.md。

## 影响

各语言服务器对方法支持、能力解释和索引就绪时机的处理不同；LSP 没有统一的“索引完成”信号。不具备兼容的临时打开同步能力的服务器不受支持，即使它能查询已关闭文档。受支持的服务器仍可能返回空结果或不完整结果，因此工具不承诺跨服务器完整性。固定的 TypeScript e2e 只建立一条兼容性基线，不代表跨语言承诺。

临时打开会重复解析并产生通知。实例内串行会增加并发 agent 的延迟，长期运行的工作区进程则持续占用内存直到 dispose。

同一运行时内的扩展名所有权互斥。即使 language id 不同，两个提供方也不能同时占用 `.ts`；这是有意接受的 MVP 限制。预期扩展方式是在注册之上增加由部署配置的 selector，允许放宽互斥占用，同时不向模型输入增加提供方选择，也不改变 `LspProvider.query`。

UTF-16 光标列与协议完全一致，但模型难以在包含非 BMP 字符的文本中准确计数。无效位置或不在符号上的位置可能返回空结果，因此错误文本和提示词示例必须说明坐标约定，同时避免鼓励模型广泛使用 LSP。

配对的文件系统／子进程提供方会对齐查询快照与服务器索引，但不会因此使受信任的语言服务器变得安全。规范 containment 会在解析时拒绝工作区外的查询源，但打开流不会在路径并发替换期间额外保证稳定句柄身份；服务器本身获得执行环境所配置的权限，仍可读取其他路径或使用缓存。
